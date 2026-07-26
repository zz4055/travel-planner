/* Travel Planner — app shell + trip workspace */

(function () {
  var state = {
    trips: [],
    places: [],
    itineraryItems: [],
    favorites: [],
    todos: [],
    notes: [],
    photos: [],
    currentTripId: "",
    appView: "home",
    tripTab: "overview",
    calendarYear: new Date().getFullYear(),
    calendarMonth: new Date().getMonth(),
    selectedDate: formatDate(new Date()),
    wizardStep: 1,
    wizard: {
      destination: "",
      startDate: "",
      endDate: "",
      styles: [],
      coverType: "gradient",
      coverImage: "",
      coverPreset: "sunset",
      coverPosition: "center"
    }
  };

  var aiChatHistory = [];
  var aiMode = "mock";
  var FAVORITES_KEY = "travelFavorites";

  var STYLE_OPTIONS = [
    "photography",
    "food",
    "coffee",
    "museums",
    "nature",
    "shopping",
    "roadTrip",
    "hiking",
    "cityWalk",
    "culture"
  ];

  /* Gradient presets. Local image previews are stored in coverImage as data URLs.
     WARNING: LocalStorage is NOT suitable for many or large images — keep previews small.
     coverImage is also ready to hold a future cloud image URL when coverType === "url". */
  var COVER_PRESETS = [
    "sunset",
    "ocean",
    "forest",
    "chiangmai",
    "minimal",
    "film",
    "map",
    "gradient",
    "journal"
  ];

  var MAX_COVER_FILE_BYTES = 2 * 1024 * 1024;
  var COVER_PREVIEW_MAX_WIDTH = 960;

  var SUGGEST_KEYS = [
    "suggest.kyoto",
    "suggest.tokyo",
    "suggest.shanghai",
    "suggest.paris",
    "suggest.bali",
    "suggest.nyc",
    "suggest.seoul",
    "suggest.lisbon"
  ];

  var editCoverState = {
    coverType: "gradient",
    coverImage: "",
    coverPreset: "sunset",
    coverPosition: "center"
  };

  function uid(prefix) {
    return prefix + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  }

  function formatDate(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function parseDate(str) {
    if (!str) {
      return null;
    }
    var parts = str.split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function t(key, vars) {
    var text = TravelI18n.t(key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        text = text.replace("{" + k + "}", vars[k]);
      });
    }
    return text;
  }

  function todayStr() {
    return formatDate(new Date());
  }

  function getTripStatus(trip) {
    var today = todayStr();
    if (today < trip.startDate) {
      return "upcoming";
    }
    if (today > trip.endDate) {
      return "completed";
    }
    return "inProgress";
  }

  function daysBetween(fromStr, toStr) {
    var a = parseDate(fromStr);
    var b = parseDate(toStr);
    if (!a || !b) {
      return 0;
    }
    return Math.round((b - a) / 86400000);
  }

  // Inclusive trip length. Accepts a trip object OR (startDate, endDate) strings.
  function tripDurationDays(tripOrStart, maybeEnd) {
    var startDate;
    var endDate;
    if (tripOrStart && typeof tripOrStart === "object") {
      startDate = tripOrStart.startDate;
      endDate = tripOrStart.endDate;
    } else {
      startDate = tripOrStart;
      endDate = maybeEnd;
    }
    if (!startDate || !endDate || endDate < startDate) {
      return 0;
    }
    return Math.max(1, daysBetween(startDate, endDate) + 1);
  }

  // Keep every todo in one shape so Todo + Calendar stay in sync.
  function normalizeTodo(todo) {
    var category = todo.category === "luggage" ? "packing" : todo.category || "during";
    var stamp = todo.updatedAt || todo.createdAt || todayStr();
    return {
      id: todo.id,
      tripId: todo.tripId,
      title: todo.title || "",
      completed: !!todo.completed,
      category: category,
      priority: todo.priority || "medium",
      dueDate: todo.dueDate || "",
      tripDay: todo.tripDay === 0 || todo.tripDay ? Number(todo.tripDay) : "",
      note: todo.note || "",
      createdAt: todo.createdAt || todayStr(),
      updatedAt: stamp
    };
  }

  // ----- Clear LocalStorage helpers (beginner-friendly names) -----

  function loadAppData() {
    var data = TravelStorage.loadAppData();
    state.trips = data.trips || [];
    state.places = data.places || [];
    state.itineraryItems = data.itineraryItems || [];
    state.todos = data.todos || [];
    state.notes = data.notes || [];
    state.photos = data.photos || [];
    state.currentTripId = data.currentTripId || "";
  }

  // Save the whole travelAppData object. Never wipe trips when saving todos/routes.
  function saveAppData() {
    TravelStorage.setTrips(state.trips);
    TravelStorage.setPlaces(state.places);
    TravelStorage.setItineraryItems(state.itineraryItems);
    TravelStorage.setTodos(state.todos);
    TravelStorage.setNotes(state.notes);
    TravelStorage.setPhotos(state.photos);
    TravelStorage.setCurrentTripId(state.currentTripId);
  }

  function getTodosByTripId(tripId) {
    return state.todos.filter(function (todo) {
      return todo.tripId === tripId;
    });
  }

  function addTodo(todoInput) {
    var todo = normalizeTodo(
      Object.assign(
        {
          id: uid("todo"),
          tripId: state.currentTripId,
          completed: false,
          createdAt: todayStr(),
          updatedAt: todayStr()
        },
        todoInput
      )
    );
    state.todos.unshift(todo);
    // Save todos only — trips stay untouched inside travelAppData.
    TravelStorage.setTodos(state.todos);
    return todo;
  }

  function updateTodo(todoId, changes) {
    var patch = Object.assign({}, changes, { updatedAt: todayStr() });
    state.todos = state.todos.map(function (todo) {
      return todo.id === todoId ? normalizeTodo(Object.assign({}, todo, patch)) : todo;
    });
    TravelStorage.setTodos(state.todos);
  }

  function deleteTodo(todoId) {
    state.todos = state.todos.filter(function (todo) {
      return todo.id !== todoId;
    });
    TravelStorage.setTodos(state.todos);
  }

  // Re-render all views that share the todo / day agenda data.
  function refreshTodoViews() {
    refreshTripAgendaViews();
  }

  // Keep Todo, Calendar, Guide, Map, and Overview looking at the same trip-day data.
  function refreshTripAgendaViews() {
    renderTodos();
    renderCalendar();
    renderGuide();
    renderOverview();
    if (typeof TravelMapRoute !== "undefined" && TravelMapRoute.renderDayExtras) {
      TravelMapRoute.renderDayExtras();
    }
    if (state.appView === "home") {
      renderDashboard();
    }
    if (state.appView === "trip" && state.tripTab === "map" && typeof TravelMapRoute !== "undefined") {
      TravelMapRoute.render();
    }
  }

  function getPlaceById(placeId) {
    return state.places.find(function (place) {
      return place.id === placeId;
    }) || null;
  }

  // Day 1 = trip.startDate, Day 2 = next day, ...
  function dateFromTripDay(trip, tripDay) {
    if (!trip || !trip.startDate || !tripDay) {
      return "";
    }
    var start = parseDate(trip.startDate);
    if (!start) {
      return "";
    }
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (Number(tripDay) - 1));
    return formatDate(d);
  }

  function tripDayFromDate(trip, dateStr) {
    if (!trip || !trip.startDate || !dateStr) {
      return "";
    }
    if (dateStr < trip.startDate || dateStr > trip.endDate) {
      return "";
    }
    return daysBetween(trip.startDate, dateStr) + 1;
  }

  function getItineraryForDate(tripId, dateStr) {
    return state.itineraryItems
      .filter(function (item) {
        return item.tripId === tripId && item.date === dateStr;
      })
      .slice()
      .sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
  }

  // Todos for a calendar date: by dueDate, or by matching tripDay.
  function getTodosForDate(tripId, dateStr) {
    var trip = getTripById(tripId);
    var dayNum = trip ? tripDayFromDate(trip, dateStr) : "";
    return getTodosByTripId(tripId).filter(function (todo) {
      if (todo.dueDate && todo.dueDate === dateStr) {
        return true;
      }
      if (dayNum && todo.tripDay && Number(todo.tripDay) === Number(dayNum)) {
        return true;
      }
      return false;
    });
  }

  // Unified day agenda used by Guide / Calendar / Map.
  function getDayAgenda(tripId, dateStr) {
    var items = [];
    getItineraryForDate(tripId, dateStr).forEach(function (stop) {
      var place = getPlaceById(stop.placeId);
      items.push({
        kind: "place",
        id: stop.id,
        placeId: stop.placeId,
        title: place ? place.name : stop.placeId,
        time: stop.plannedTime || "",
        category: place ? place.category : "other",
        completed: !!stop.completed,
        note: stop.note || (place ? place.note : ""),
        order: stop.order || 0
      });
    });
    getTodosForDate(tripId, dateStr).forEach(function (todo) {
      items.push({
        kind: "todo",
        id: todo.id,
        title: todo.title,
        time: "",
        category: todo.category,
        completed: !!todo.completed,
        note: todo.note || "",
        priority: todo.priority,
        order: 1000
      });
    });
    return items;
  }

  // Keep dueDate and tripDay pointing at the same day when possible.
  function alignTodoScheduleFields(data) {
    var trip = getCurrentTrip();
    if (!trip) {
      return data;
    }
    var next = Object.assign({}, data);
    if (next.tripDay && !next.dueDate) {
      next.dueDate = dateFromTripDay(trip, next.tripDay);
    } else if (next.dueDate && !next.tripDay) {
      next.tripDay = tripDayFromDate(trip, next.dueDate) || "";
    } else if (next.tripDay && next.dueDate) {
      // Prefer explicit trip day → sync due date to that day.
      next.dueDate = dateFromTripDay(trip, next.tripDay) || next.dueDate;
    }
    return next;
  }

  function countdownText(trip) {
    var status = getTripStatus(trip);
    var today = todayStr();
    if (status === "upcoming") {
      return t("home.daysUntil", { n: Math.max(0, daysBetween(today, trip.startDate)) });
    }
    if (status === "inProgress") {
      var left = Math.max(0, daysBetween(today, trip.endDate));
      return left === 0 ? t("home.tripOngoing") : t("home.daysLeft", { n: left });
    }
    return t("home.tripEnded");
  }

  function forTrip(list, tripId) {
    return list.filter(function (item) {
      return item.tripId === tripId;
    });
  }

  function getTripById(id) {
    return state.trips.find(function (trip) {
      return trip.id === id;
    }) || null;
  }

  function getCurrentTrip() {
    return getTripById(state.currentTripId);
  }

  function isAiFavorite(favorite) {
    return favorite && (favorite.type === "ai" || favorite.kind === "ai");
  }

  function loadFavorites() {
    try {
      var parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter(function (favorite) {
            if (!favorite || !favorite.id || !favorite.tripId) {
              return false;
            }
            if (isAiFavorite(favorite)) {
              return Boolean(favorite.question || favorite.placeName);
            }
            return Boolean(favorite.placeName);
          })
        : [];
    } catch (error) {
      console.warn("Unable to read travelFavorites; using an empty list.", error);
      return [];
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
      return true;
    } catch (error) {
      console.error("Unable to save travelFavorites.", error);
      alert("收藏保存失败，请检查浏览器存储设置。");
      return false;
    }
  }

  function findFavorite(tripId, placeId) {
    return state.favorites.find(function (favorite) {
      return !isAiFavorite(favorite) && favorite.tripId === tripId && favorite.placeId === placeId;
    }) || null;
  }

  function findAiFavorite(tripId, question) {
    var q = String(question || "").trim();
    return state.favorites.find(function (favorite) {
      return isAiFavorite(favorite) && favorite.tripId === tripId && String(favorite.question || "").trim() === q;
    }) || null;
  }

  function toggleFavorite(entry, dateStr) {
    var trip = getCurrentTrip();
    var place = entry && entry.placeId ? getPlaceById(entry.placeId) : null;
    if (!trip || !place) {
      return;
    }
    var existing = findFavorite(trip.id, place.id);
    if (existing) {
      state.favorites = state.favorites.filter(function (favorite) {
        return favorite.id !== existing.id;
      });
    } else {
      var location = place.address || "";
      if (!location && place.latitude && place.longitude) {
        location = Number(place.latitude).toFixed(5) + ", " + Number(place.longitude).toFixed(5);
      }
      state.favorites.unshift({
        id: "favorite_" + trip.id + "_" + place.id,
        type: "place",
        tripId: trip.id,
        placeId: place.id,
        placeName: place.name || entry.title || "",
        day: tripDayFromDate(trip, dateStr) || "",
        date: dateStr || "",
        location: location || trip.destination || "",
        summary: entry.note || place.note || "",
        createdAt: new Date().toISOString()
      });
    }
    if (saveFavorites()) {
      renderGuide();
      renderFavorites();
    }
  }

  function toggleAiFavorite(question, answer) {
    var trip = getCurrentTrip();
    var q = String(question || "").trim();
    if (!trip || !q) {
      return;
    }
    var existing = findAiFavorite(trip.id, q);
    if (existing) {
      state.favorites = state.favorites.filter(function (favorite) {
        return favorite.id !== existing.id;
      });
    } else {
      state.favorites.unshift({
        id: "favorite_ai_" + trip.id + "_" + Date.now(),
        type: "ai",
        tripId: trip.id,
        placeId: "",
        placeName: q.length > 28 ? q.slice(0, 28) + "…" : q,
        question: q,
        day: "",
        date: "",
        location: trip.destination || trip.name || "",
        summary: String(answer || "").trim(),
        createdAt: new Date().toISOString()
      });
    }
    if (saveFavorites()) {
      renderFavorites();
      refreshAiFavoriteButtons();
    }
  }

  function setAiFavoriteButtonState(btn, question) {
    var trip = getCurrentTrip();
    var saved = trip ? findAiFavorite(trip.id, question) : null;
    btn.textContent = saved ? "♥ 已收藏" : "♡ 收藏提问";
    btn.classList.toggle("is-favorite", !!saved);
    btn.setAttribute("aria-pressed", saved ? "true" : "false");
  }

  function refreshAiFavoriteButtons() {
    var log = document.getElementById("aiChatLog");
    if (!log) {
      return;
    }
    Array.prototype.forEach.call(log.querySelectorAll("[data-ai-question]"), function (btn) {
      setAiFavoriteButtonState(btn, btn.getAttribute("data-ai-question") || "");
    });
  }

  function renderFavorites() {
    var list = document.getElementById("favoritesList");
    var empty = document.getElementById("favoritesEmpty");
    var clearBtn = document.getElementById("clearFavoritesBtn");
    if (!list || !empty || !clearBtn) {
      return;
    }
    list.innerHTML = "";
    empty.hidden = state.favorites.length > 0;
    clearBtn.hidden = state.favorites.length === 0;

    state.favorites.forEach(function (favorite) {
      var trip = getTripById(favorite.tripId);
      var card = document.createElement("article");
      var aiItem = isAiFavorite(favorite);
      card.className = "favorite-card" + (aiItem ? " is-ai" : "");
      card.innerHTML =
        "<div class='favorite-card-body'>" +
        "<p class='favorite-type'></p>" +
        "<h4></h4><p class='favorite-meta'></p><p class='favorite-summary'></p></div>" +
        "<button type='button' class='btn danger small favorite-remove'>取消收藏</button>";
      card.querySelector(".favorite-type").textContent = aiItem ? "AI 提问" : "攻略景点";
      card.querySelector("h4").textContent = aiItem
        ? favorite.question || favorite.placeName
        : favorite.placeName;
      card.querySelector(".favorite-meta").textContent = aiItem
        ? (trip ? trip.name + " · " : "") + (favorite.location || "当前旅行")
        : (trip ? trip.name + " · " : "") +
          (favorite.day ? "第 " + favorite.day + " 天 · " : "") +
          (favorite.location || "位置未填写");
      var summary = card.querySelector(".favorite-summary");
      summary.textContent = favorite.summary || (aiItem ? "暂无回答摘要" : "暂无简介");
      card.querySelector(".favorite-remove").addEventListener("click", function () {
        state.favorites = state.favorites.filter(function (item) {
          return item.id !== favorite.id;
        });
        if (saveFavorites()) {
          renderFavorites();
          renderGuide();
          refreshAiFavoriteButtons();
        }
      });
      list.appendChild(card);
    });
  }

  function defaultCoverFields() {
    return {
      coverType: "gradient",
      coverImage: "",
      coverPreset: "sunset",
      coverPosition: "center"
    };
  }

  function normalizeTripCover(trip) {
    if (!trip.coverType) {
      if (trip.coverUrl) {
        trip.coverType = "url";
        trip.coverImage = trip.coverUrl;
        trip.coverPreset = "sunset";
        trip.coverPosition = "center";
      } else if (trip.coverStyle) {
        trip.coverType = "gradient";
        trip.coverImage = "";
        trip.coverPreset =
          COVER_PRESETS.indexOf(trip.coverStyle) >= 0 ? trip.coverStyle : "gradient";
        trip.coverPosition = "center";
      } else {
        Object.assign(trip, defaultCoverFields());
      }
    }
    if (!trip.coverPreset) {
      trip.coverPreset = "sunset";
    }
    if (!trip.coverPosition) {
      trip.coverPosition = "center";
    }
    if (typeof trip.coverImage !== "string") {
      trip.coverImage = "";
    }
    return trip;
  }

  function getCoverSource(trip) {
    var normalized = normalizeTripCover(Object.assign({}, trip));
    if (
      (normalized.coverType === "image" || normalized.coverType === "url") &&
      normalized.coverImage
    ) {
      return { kind: "image", value: normalized.coverImage, position: normalized.coverPosition };
    }
    return {
      kind: "gradient",
      value: normalized.coverPreset || "sunset",
      position: normalized.coverPosition || "center"
    };
  }

  function applyCoverStyle(el, trip) {
    if (!el) {
      return;
    }
    el.className = el.className
      .split(" ")
      .filter(function (name) {
        return (
          name &&
          name.indexOf("cover-style-") !== 0 &&
          name.indexOf("cover-preset-") !== 0 &&
          name !== "has-image"
        );
      })
      .join(" ");

    var existing = el.querySelector(".cover-media");
    if (existing) {
      existing.remove();
    }
    el.style.backgroundImage = "";

    var source = getCoverSource(trip);
    if (source.kind === "image") {
      var img = document.createElement("img");
      img.className = "cover-media";
      img.alt = "";
      img.src = source.value;
      img.style.objectPosition = source.position || "center";
      img.addEventListener("error", function () {
        img.remove();
        el.classList.add("cover-preset-" + (trip.coverPreset || "sunset"));
      });
      el.appendChild(img);
      el.classList.add("has-image");
      return;
    }

    el.classList.add("cover-preset-" + source.value);
  }

  /**
   * Read a local file into a small JPEG data URL for LocalStorage preview.
   * WARNING: LocalStorage is not suitable for many or large images.
   * Keep this preview tiny; future versions should upload to cloud and store only a URL in coverImage.
   */
  function readCoverFileAsPreview(file, onSuccess, onError) {
    if (!file || !file.type || file.type.indexOf("image/") !== 0) {
      onError(t("cover.fileInvalid"));
      return;
    }
    if (file.size > MAX_COVER_FILE_BYTES) {
      onError(t("cover.fileTooLarge"));
      return;
    }

    var reader = new FileReader();
    reader.onerror = function () {
      onError(t("cover.fileInvalid"));
    };
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        var scale = Math.min(1, COVER_PREVIEW_MAX_WIDTH / img.width);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Compressed preview only — do not store original camera files in LocalStorage.
        onSuccess(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = function () {
        onError(t("cover.fileInvalid"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function coverLabel(cover) {
    if (cover.coverType === "image" && cover.coverImage) {
      return t("cover.typeImage");
    }
    if (cover.coverType === "url" && cover.coverImage) {
      return t("cover.typeUrl");
    }
    return t("preset." + (cover.coverPreset || "sunset"));
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr) {
      return "";
    }
    var d = parseDate(dateStr);
    if (!d) {
      return dateStr;
    }
    var monthsEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (TravelI18n.getLanguage() === "en") {
      return monthsEn[d.getMonth()] + " " + d.getDate();
    }
    return d.getMonth() + 1 + "月" + d.getDate() + "日";
  }

  function getFeaturedTrip() {
    if (!state.trips.length) {
      return null;
    }
    var inProgress = state.trips.filter(function (trip) {
      return getTripStatus(trip) === "inProgress";
    });
    if (inProgress.length) {
      return inProgress[0];
    }
    var upcoming = state.trips
      .filter(function (trip) {
        return getTripStatus(trip) === "upcoming";
      })
      .sort(function (a, b) {
        return a.startDate.localeCompare(b.startDate);
      });
    if (upcoming.length) {
      return upcoming[0];
    }
    return state.trips.slice().sort(function (a, b) {
      return b.endDate.localeCompare(a.endDate);
    })[0];
  }

  function loadAll() {
    // Page open: load one travelAppData object into memory.
    loadAppData();

    if (!TravelStorage.isSeeded() && state.trips.length === 0) {
      seedDemoData();
      TravelStorage.markSeeded();
    }

    state.trips = state.trips.map(function (trip) {
      return normalizeTripCover(trip);
    });

    // Keep older demos in sync with the Chiang Mai sample trip brief.
    state.trips = state.trips.map(function (trip) {
      if (trip.id === "trip_demo_001" && (trip.name === "京都五日游" || trip.destination === "日本京都")) {
        return Object.assign({}, trip, {
          name: "Kyoto Five-Day Trip",
          destination: "Kyoto, Japan",
          styles: trip.styles && trip.styles.length ? trip.styles : ["culture", "food", "photography"]
        });
      }
      if (
        trip.id === "trip_demo_002" ||
        (trip.name && trip.name.toLowerCase().indexOf("chiang mai") >= 0) ||
        (trip.destination && trip.destination.toLowerCase().indexOf("chiang mai") >= 0)
      ) {
        return Object.assign({}, trip, {
          id: trip.id || "trip_demo_002",
          name: trip.name === "青岛周末" || trip.name === "Chiang Mai Escape" ? "Chiang Mai Trip" : trip.name || "Chiang Mai Trip",
          destination:
            trip.destination === "中国青岛" || trip.destination === "Chiang Mai"
              ? "Chiang Mai, Thailand"
              : trip.destination || "Chiang Mai, Thailand",
          startDate: trip.startDate === "2026-05-01" || !trip.startDate ? "2026-07-12" : trip.startDate,
          endDate: trip.endDate === "2026-05-06" || !trip.endDate ? "2026-07-17" : trip.endDate,
          coverType: trip.coverType || "gradient",
          coverImage: trip.coverImage || "",
          coverPreset: trip.coverPreset || "chiangmai",
          coverPosition: trip.coverPosition || "center",
          styles: trip.styles && trip.styles.length ? trip.styles : ["food", "culture", "nature"]
        });
      }
      return trip;
    });

    // Prefer Chiang Mai as the sample current trip when none is selected,
    // or when still pointing at a renamed legacy Chiang Mai demo.
    var chiangMai = state.trips.find(function (trip) {
      return trip.id === "trip_demo_002";
    });
    if (chiangMai && (!state.currentTripId || state.currentTripId === "trip_demo_002")) {
      state.currentTripId = chiangMai.id;
    }

    state.todos = state.todos.map(normalizeTodo);

    // If an older seed only had Kyoto todos, add Chiang Mai sample todos once.
    var chiangMaiTrip = state.trips.find(function (trip) {
      return trip.id === "trip_demo_002";
    });
    if (chiangMaiTrip && getTodosByTripId("trip_demo_002").length === 0) {
      state.todos = state.todos.concat(buildChiangMaiSampleTodos());
      if (!forTrip(state.notes, "trip_demo_002").length) {
        state.notes = state.notes.concat(buildChiangMaiSampleNotes());
      }
      if (!forTrip(state.places, "trip_demo_002").length) {
        state.places = state.places.concat(buildChiangMaiSamplePlaces());
      }
      // Make Chiang Mai the sample trip to enter after this upgrade.
      state.currentTripId = "trip_demo_002";
    }

    // Upgrade older Chiang Mai places with coordinates + sample daily routes.
    state.places = state.places.map(normalizePlace);
    enrichChiangMaiPlacesWithCoords();
    if (
      state.trips.some(function (trip) {
        return trip.id === "trip_demo_002";
      }) &&
      !state.itineraryItems.some(function (item) {
        return item.tripId === "trip_demo_002";
      })
    ) {
      // Replace thin 2-place demos with the richer route sample when needed.
      var hasOldThinPlaces =
        forTrip(state.places, "trip_demo_002").length < 4;
      if (hasOldThinPlaces) {
        state.places = state.places
          .filter(function (place) {
            return place.tripId !== "trip_demo_002";
          })
          .concat(buildChiangMaiSamplePlaces());
      }
      state.itineraryItems = state.itineraryItems.concat(buildChiangMaiSampleItinerary());
    }

    saveAppData();

    if (state.currentTripId && !getCurrentTrip()) {
      state.currentTripId = state.trips[0] ? state.trips[0].id : "";
      TravelStorage.setCurrentTripId(state.currentTripId);
    }
  }

  function normalizePlace(place) {
    return {
      id: place.id,
      tripId: place.tripId,
      name: place.name || "",
      category: place.category || "other",
      address: place.address || "",
      latitude: typeof place.latitude === "number" ? place.latitude : Number(place.latitude) || 0,
      longitude: typeof place.longitude === "number" ? place.longitude : Number(place.longitude) || 0,
      image: place.image || "",
      note: place.note || ""
    };
  }

  // Fill missing Chiang Mai demo coordinates without wiping user places.
  function enrichChiangMaiPlacesWithCoords() {
    var sampleById = {};
    buildChiangMaiSamplePlaces().forEach(function (place) {
      sampleById[place.id] = place;
    });
    state.places = state.places.map(function (place) {
      var sample = sampleById[place.id];
      if (!sample) {
        return place;
      }
      if (place.latitude && place.longitude) {
        return place;
      }
      return Object.assign({}, place, {
        latitude: sample.latitude,
        longitude: sample.longitude,
        name: place.name || sample.name,
        address: place.address || sample.address
      });
    });
  }

  function buildChiangMaiSampleTodos() {
    var tripChiangMai = "trip_demo_002";
    return [
      normalizeTodo({
        id: "todo_demo_cm_001",
        tripId: tripChiangMai,
        title: "Book Old City guesthouse",
        category: "booking",
        dueDate: "2026-07-12",
        priority: "high",
        completed: false,
        tripDay: 1,
        note: "Near Tha Phae Gate",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01"
      }),
      normalizeTodo({
        id: "todo_demo_cm_002",
        tripId: tripChiangMai,
        title: "Check passport & visa",
        category: "documents",
        dueDate: "2026-07-12",
        priority: "high",
        completed: true,
        tripDay: "",
        note: "",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-10"
      }),
      normalizeTodo({
        id: "todo_demo_cm_003",
        tripId: tripChiangMai,
        title: "Pack light linen clothes",
        category: "packing",
        dueDate: "2026-07-11",
        priority: "medium",
        completed: false,
        tripDay: "",
        note: "Warm evenings",
        createdAt: "2026-07-05",
        updatedAt: "2026-07-05"
      }),
      normalizeTodo({
        id: "todo_demo_cm_004",
        tripId: tripChiangMai,
        title: "Sunrise at Doi Suthep",
        category: "during",
        dueDate: "2026-07-13",
        priority: "high",
        completed: false,
        tripDay: 2,
        note: "Wear comfortable shoes",
        createdAt: "2026-07-08",
        updatedAt: "2026-07-08"
      }),
      normalizeTodo({
        id: "todo_demo_cm_005",
        tripId: tripChiangMai,
        title: "Buy coffee beans to bring home",
        category: "shopping",
        dueDate: "2026-07-16",
        priority: "low",
        completed: false,
        tripDay: 5,
        note: "",
        createdAt: "2026-07-09",
        updatedAt: "2026-07-09"
      })
    ];
  }

  function buildChiangMaiSampleNotes() {
    return [
      {
        id: "note_demo_cm_001",
        tripId: "trip_demo_002",
        content: "Want one slow morning in a riverside cafe.",
        createdAt: "2026-07-10"
      },
      {
        id: "note_demo_cm_002",
        tripId: "trip_demo_002",
        content: "Try khao soi at least twice.",
        createdAt: "2026-07-09"
      }
    ];
  }

  function buildChiangMaiSamplePlaces() {
    return [
      {
        id: "place_demo_cm_001",
        tripId: "trip_demo_002",
        name: "Wat Phra Singh",
        category: "attraction",
        address: "Chiang Mai Old City",
        latitude: 18.7885,
        longitude: 98.9817,
        image: "",
        note: "Start the Old City walk here"
      },
      {
        id: "place_demo_cm_002",
        tripId: "trip_demo_002",
        name: "Wat Chedi Luang",
        category: "attraction",
        address: "Phra Pok Klao Rd",
        latitude: 18.7869,
        longitude: 98.9865,
        image: "",
        note: "Giant chedi in the center"
      },
      {
        id: "place_demo_cm_003",
        tripId: "trip_demo_002",
        name: "Tha Phae Gate",
        category: "photoSpot",
        address: "Tha Phae Gate",
        latitude: 18.7877,
        longitude: 98.9934,
        image: "",
        note: "Good evening photos"
      },
      {
        id: "place_demo_cm_004",
        tripId: "trip_demo_002",
        name: "Sunday Night Market",
        category: "shopping",
        address: "Ratchadamnoen Road",
        latitude: 18.7879,
        longitude: 98.9865,
        image: "",
        note: "Street food + crafts"
      },
      {
        id: "place_demo_cm_005",
        tripId: "trip_demo_002",
        name: "Wat Phra That Doi Suthep",
        category: "attraction",
        address: "Doi Suthep",
        latitude: 18.8048,
        longitude: 98.9216,
        image: "",
        note: "Go in the morning"
      },
      {
        id: "place_demo_cm_006",
        tripId: "trip_demo_002",
        name: "Riverside Cafe",
        category: "cafe",
        address: "Ping River",
        latitude: 18.7898,
        longitude: 98.9992,
        image: "",
        note: "Slow coffee stop"
      }
    ];
  }

  function buildChiangMaiSampleItinerary() {
    return [
      {
        id: "itin_demo_cm_001",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_001",
        date: "2026-07-12",
        plannedTime: "09:00",
        order: 1,
        completed: false,
        distanceFromPrevious: "",
        durationFromPrevious: "",
        note: ""
      },
      {
        id: "itin_demo_cm_002",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_002",
        date: "2026-07-12",
        plannedTime: "10:30",
        order: 2,
        completed: false,
        distanceFromPrevious: "0.6 km",
        durationFromPrevious: "8 min",
        note: ""
      },
      {
        id: "itin_demo_cm_003",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_003",
        date: "2026-07-12",
        plannedTime: "12:00",
        order: 3,
        completed: false,
        distanceFromPrevious: "0.8 km",
        durationFromPrevious: "10 min",
        note: ""
      },
      {
        id: "itin_demo_cm_004",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_005",
        date: "2026-07-13",
        plannedTime: "07:30",
        order: 1,
        completed: false,
        distanceFromPrevious: "",
        durationFromPrevious: "",
        note: "Sunrise visit"
      },
      {
        id: "itin_demo_cm_005",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_006",
        date: "2026-07-13",
        plannedTime: "11:00",
        order: 2,
        completed: false,
        distanceFromPrevious: "12.5 km",
        durationFromPrevious: "35 min",
        note: ""
      },
      {
        id: "itin_demo_cm_006",
        tripId: "trip_demo_002",
        placeId: "place_demo_cm_004",
        date: "2026-07-13",
        plannedTime: "18:00",
        order: 3,
        completed: false,
        distanceFromPrevious: "1.2 km",
        durationFromPrevious: "15 min",
        note: ""
      }
    ];
  }

  function seedDemoData() {
    var tripKyoto = "trip_demo_001";
    var tripChiangMai = "trip_demo_002";
    state.trips = [
      {
        id: tripChiangMai,
        name: "Chiang Mai Trip",
        destination: "Chiang Mai, Thailand",
        startDate: "2026-07-12",
        endDate: "2026-07-17",
        coverType: "gradient",
        coverImage: "",
        coverPreset: "chiangmai",
        coverPosition: "center",
        styles: ["food", "culture", "nature", "coffee"],
        guide: "Old City temples, night markets, and a slow cafe morning.",
        summary: "",
        createdAt: "2026-07-01"
      },
      {
        id: tripKyoto,
        name: "Kyoto Five-Day Trip",
        destination: "Kyoto, Japan",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        coverType: "url",
        coverImage: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800",
        coverPreset: "sunset",
        coverPosition: "center",
        styles: ["culture", "food", "photography"],
        guide: "Day1 Kiyomizu & Ninenzaka\nDay2 Arashiyama bamboo\nDay3 Fushimi Inari",
        summary: "",
        createdAt: "2026-07-11"
      }
    ];
    state.places = buildChiangMaiSamplePlaces().concat([
      {
        id: "place_demo_001",
        tripId: tripKyoto,
        name: "Kiyomizu-dera",
        category: "attraction",
        address: "Higashiyama",
        latitude: 34.9949,
        longitude: 135.785,
        image: "",
        note: "Go early"
      }
    ]);
    state.itineraryItems = buildChiangMaiSampleItinerary();
    state.todos = [
      normalizeTodo({
        id: "todo_demo_cm_001",
        tripId: tripChiangMai,
        title: "Book Old City guesthouse",
        category: "booking",
        dueDate: "2026-07-12",
        priority: "high",
        completed: false,
        tripDay: 1,
        note: "Near Tha Phae Gate",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01"
      }),
      normalizeTodo({
        id: "todo_demo_cm_002",
        tripId: tripChiangMai,
        title: "Check passport & visa",
        category: "documents",
        dueDate: "2026-07-12",
        priority: "high",
        completed: true,
        tripDay: "",
        note: "",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-10"
      }),
      normalizeTodo({
        id: "todo_demo_cm_003",
        tripId: tripChiangMai,
        title: "Pack light linen clothes",
        category: "packing",
        dueDate: "2026-07-11",
        priority: "medium",
        completed: false,
        tripDay: "",
        note: "Warm evenings",
        createdAt: "2026-07-05",
        updatedAt: "2026-07-05"
      }),
      normalizeTodo({
        id: "todo_demo_cm_004",
        tripId: tripChiangMai,
        title: "Sunrise at Doi Suthep",
        category: "during",
        dueDate: "2026-07-13",
        priority: "high",
        completed: false,
        tripDay: 2,
        note: "Wear comfortable shoes",
        createdAt: "2026-07-08",
        updatedAt: "2026-07-08"
      }),
      normalizeTodo({
        id: "todo_demo_cm_005",
        tripId: tripChiangMai,
        title: "Buy coffee beans to bring home",
        category: "shopping",
        dueDate: "2026-07-16",
        priority: "low",
        completed: false,
        tripDay: 5,
        note: "",
        createdAt: "2026-07-09",
        updatedAt: "2026-07-09"
      }),
      normalizeTodo({
        id: "todo_demo_ky_001",
        tripId: tripKyoto,
        title: "Book hotel near Gion",
        category: "booking",
        dueDate: "2026-07-20",
        priority: "high",
        completed: false,
        tripDay: "",
        note: "Kyoto-only todo (should not show in Chiang Mai)",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01"
      })
    ];
    state.notes = [
      {
        id: "note_demo_cm_001",
        tripId: tripChiangMai,
        content: "Want one slow morning in a riverside cafe.",
        createdAt: "2026-07-10"
      },
      {
        id: "note_demo_cm_002",
        tripId: tripChiangMai,
        content: "Try khao soi at least twice.",
        createdAt: "2026-07-09"
      }
    ];
    state.photos = [
      {
        id: "photo_demo_cm_001",
        tripId: tripChiangMai,
        title: "Old City evening",
        date: "2026-07-12",
        location: "Chiang Mai Old City",
        description: "Sample photo for the Chiang Mai trip.",
        imageUrl: ""
      }
    ];
    state.currentTripId = tripChiangMai;
    saveAppData();
  }

  // Alias kept for older call sites — same as saveAppData().
  function persistAll() {
    saveAppData();
  }

  /* ---------- Navigation / routing ---------- */

  function showAppView(viewName) {
    state.appView = viewName;
    document.body.classList.toggle("in-workspace", viewName === "trip");
    document.body.classList.toggle("in-create", viewName === "create");

    document.querySelectorAll("[data-app-view]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-app-view") === viewName);
    });

    document.querySelectorAll(".view").forEach(function (view) {
      view.classList.toggle("active", view.id === "view-" + viewName);
    });

    if (viewName === "home") {
      renderDashboard();
    }
    if (viewName === "trips") {
      renderTripCards();
    }
    if (viewName === "trip") {
      renderWorkspace();
    }
    if (viewName === "create") {
      renderWizard();
    }
  }

  function openCreateWizard() {
    state.wizardStep = 1;
    state.wizard = {
      destination: "",
      startDate: "",
      endDate: "",
      styles: [],
      coverType: "gradient",
      coverImage: "",
      coverPreset: "sunset",
      coverPosition: "center"
    };
    document.getElementById("wizardDestination").value = "";
    document.getElementById("wizardStart").value = "";
    document.getElementById("wizardEnd").value = "";
    showAppView("create");
    setTimeout(function () {
      document.getElementById("wizardDestination").focus();
    }, 50);
  }

  function openTrip(tripId, tab) {
    var trip = getTripById(tripId);
    if (!trip) {
      showAppView("trips");
      return;
    }
    state.currentTripId = tripId;
    TravelStorage.setCurrentTripId(tripId);
    state.tripTab = tab || "overview";
    aiChatHistory = [];
    var aiLog = document.getElementById("aiChatLog");
    if (aiLog) {
      aiLog.innerHTML = "";
    }
    var adviceCard = document.getElementById("aiAdviceCard");
    if (adviceCard) {
      adviceCard.hidden = true;
    }
    showAppView("trip");
    setTripTab(state.tripTab);
  }

  function setTripTab(tabName) {
    state.tripTab = tabName;
    document.querySelectorAll(".trip-tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-trip-tab") === tabName);
    });
    document.querySelectorAll(".trip-pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.id === "pane-" + tabName);
    });
    if (tabName === "calendar") {
      renderCalendar();
    }
    if (tabName === "todo") {
      fillTripDayOptions();
      renderTodos();
    }
    if (tabName === "overview") {
      renderOverview();
    }
    if (tabName === "map") {
      TravelMapRoute.onShow();
    }
    if (tabName === "guide") {
      renderGuide();
    }
    if (tabName === "favorites") {
      renderFavorites();
    }
    if (tabName === "ai") {
      ensureAiWelcome();
      refreshAiStatus();
    }
    if (tabName === "ai") {
      refreshAiCatalog();
      ensureAiWelcome();
      refreshAiStatus();
    }
  }

  function formatTripDaysLabel(trip) {
    if (!trip || !trip.startDate || !trip.endDate) {
      return "—";
    }
    var start = new Date(trip.startDate + "T00:00:00");
    var end = new Date(trip.endDate + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return "—";
    }
    var days = Math.round((end - start) / 86400000) + 1;
    var nights = Math.max(days - 1, 0);
    return days + "天" + nights + "晚";
  }

  function refreshAiCatalog() {
    var trip = getCurrentTrip();
    var destEl = document.getElementById("aiCatalogDestination");
    var daysEl = document.getElementById("aiCatalogDays");
    if (destEl) {
      destEl.textContent = trip && trip.destination ? trip.destination : "—";
    }
    if (daysEl) {
      daysEl.textContent = formatTripDaysLabel(trip);
    }
  }

  function getAiCatalogOptions() {
    var preferences = Array.prototype.map
      .call(document.querySelectorAll('input[name="ai-pref"]:checked'), function (el) {
        return el.value;
      });
    var paceEl = document.getElementById("aiPaceSelect");
    return {
      preferences: preferences,
      pace: paceEl ? paceEl.value : "均衡",
      daysLabel: formatTripDaysLabel(getCurrentTrip())
    };
  }

  function addCustomAiPreference(rawValue) {
    var value = String(rawValue || "").trim().replace(/\s+/g, " ");
    if (!value) {
      appendAiBubble("ai", t("ai.customPrefEmpty"));
      return false;
    }
    if (value.length > 20) {
      value = value.slice(0, 20);
    }
    var group = document.getElementById("aiPreferenceChips");
    if (!group) {
      return false;
    }
    var exists = Array.prototype.some.call(
      group.querySelectorAll('input[name="ai-pref"]'),
      function (el) {
        return el.value === value;
      }
    );
    if (exists) {
      Array.prototype.forEach.call(group.querySelectorAll('input[name="ai-pref"]'), function (el) {
        if (el.value === value) {
          el.checked = true;
        }
      });
      appendAiBubble("ai", t("ai.customPrefExists"));
      return false;
    }
    var label = document.createElement("label");
    label.className = "ai-chip";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.name = "ai-pref";
    input.value = value;
    input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(value));
    group.appendChild(label);
    return true;
  }

  function formatAiSourceLabel(mode, model) {
    if (mode === "live") {
      return t("ai.sourceDeepseek", { model: model || "deepseek-chat" });
    }
    if (mode === "offline") {
      return t("ai.sourceOffline");
    }
    return t("ai.sourceMock");
  }

  function renderAiAdvice(advice, mode, model) {
    var card = document.getElementById("aiAdviceCard");
    if (!card) {
      return;
    }
    if (!advice || (!advice.summary && !(advice.highlights || []).length && !(advice.itinerary || []).length)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    var source = document.getElementById("aiAdviceSource");
    if (source) {
      source.textContent = formatAiSourceLabel(mode, model);
      source.className =
        "ai-advice-badge" +
        (mode === "live" ? " live" : mode === "offline" ? " offline" : " mock");
    }
    document.getElementById("aiAdviceSummary").textContent = advice.summary || "";
    var highlights = document.getElementById("aiAdviceHighlights");
    highlights.innerHTML = "";
    (advice.highlights || []).forEach(function (item) {
      var li = document.createElement("li");
      li.textContent = item;
      highlights.appendChild(li);
    });
    var itinerary = document.getElementById("aiAdviceItinerary");
    itinerary.innerHTML = "";
    (advice.itinerary || []).forEach(function (item) {
      var li = document.createElement("li");
      li.textContent = item;
      itinerary.appendChild(li);
    });
    document.getElementById("aiAdviceReminder").textContent = advice.reminder || "";
  }

  function appendAiBubble(role, text, extraClass, sourceMeta) {
    var log = document.getElementById("aiChatLog");
    if (!log) {
      return null;
    }
    var div = document.createElement("div");
    div.className = "bubble " + role + (extraClass ? " " + extraClass : "");
    if (role === "ai" && sourceMeta && sourceMeta.label && extraClass !== "typing") {
      var meta = document.createElement("div");
      meta.className = "bubble-source";
      meta.textContent = sourceMeta.label;
      div.appendChild(meta);
    }
    var body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent = text;
    div.appendChild(body);
    if (role === "ai" && sourceMeta && sourceMeta.question && extraClass !== "typing") {
      var actions = document.createElement("div");
      actions.className = "bubble-actions";
      var favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "btn small favorite-toggle ai-favorite-toggle";
      favBtn.setAttribute("data-ai-question", sourceMeta.question);
      setAiFavoriteButtonState(favBtn, sourceMeta.question);
      favBtn.addEventListener("click", function () {
        toggleAiFavorite(sourceMeta.question, text);
      });
      actions.appendChild(favBtn);
      div.appendChild(actions);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function ensureAiWelcome() {
    var log = document.getElementById("aiChatLog");
    if (!log || log.children.length) {
      return;
    }
    appendAiBubble("ai", t("ai.welcome"), "", {
      label: formatAiSourceLabel(aiMode || "mock")
    });
  }

  function setAiStatus(mode, detail) {
    aiMode = mode;
    var badge = document.getElementById("aiBadge");
    var hint = document.getElementById("aiHint");
    var sourceLine = document.getElementById("aiSourceLine");
    if (!badge) {
      return;
    }
    var model = detail || "";
    badge.textContent =
      mode === "live" ? t("ai.badgeLive") : mode === "offline" ? t("ai.badgeOffline") : t("ai.badgeMock");
    badge.className = "ai-badge " + (mode === "live" ? "live" : mode === "offline" ? "offline" : "mock");
    badge.title = formatAiSourceLabel(mode, model);
    if (sourceLine) {
      sourceLine.textContent = formatAiSourceLabel(mode, model);
      sourceLine.className =
        "ai-source-line" +
        (mode === "live" ? " live" : mode === "offline" ? " offline" : " mock");
    }
    if (hint) {
      hint.textContent = t("ai.hint");
    }
  }

  function refreshAiStatus() {
    if (!window.TravelAI) {
      setAiStatus("offline", "ai.js missing");
      return;
    }
    window.TravelAI.checkHealth().then(function (health) {
      var settings = window.TravelAI.loadSettings();
      var hasKey = Boolean((settings.apiKey || "").trim()) || Boolean(health.configured);
      if (health.offline) {
        setAiStatus("offline", "npm start on port 3002");
        return;
      }
      if (hasKey) {
        setAiStatus("live", settings.model || health.model || "");
        return;
      }
      setAiStatus("mock", "no api key");
    });
  }

  function buildAiTripContext() {
    var trip = getCurrentTrip();
    if (!trip) {
      return null;
    }
    var places = forTrip(state.places, trip.id).map(function (place) {
      var stops = state.itineraryItems.filter(function (item) {
        return item.tripId === trip.id && item.placeId === place.id;
      });
      return {
        name: place.name,
        note: place.note || "",
        date: stops[0] ? stops[0].date : "",
        category: place.category || ""
      };
    });
    var todos = forTrip(state.todos, trip.id).map(function (todo) {
      return {
        title: todo.title,
        date: todo.dueDate || dateFromTripDay(trip, todo.tripDay) || "",
        done: !!todo.completed,
        category: todo.category || ""
      };
    });
    return { trip: trip, places: places, todos: todos };
  }

  function applyAiPlan(plan) {
    var trip = getCurrentTrip();
    if (!trip || !plan) {
      return { placeCount: 0, stopCount: 0, todoCount: 0 };
    }

    var existingPlaceNames = {};
    forTrip(state.places, trip.id).forEach(function (place) {
      existingPlaceNames[place.name] = true;
    });
    var existingTodoKeys = {};
    forTrip(state.todos, trip.id).forEach(function (todo) {
      existingTodoKeys[(todo.dueDate || "") + "|" + todo.title] = true;
    });

    var placeCount = 0;
    var stopCount = 0;
    var todoCount = 0;

    (plan.places || []).forEach(function (row) {
      if (!row || !row.name || !row.date) {
        return;
      }
      if (row.date < trip.startDate || row.date > trip.endDate) {
        return;
      }

      var place = null;
      if (!existingPlaceNames[row.name]) {
        place = normalizePlace({
          id: uid("place"),
          tripId: trip.id,
          name: row.name,
          category: row.category || "sightseeing",
          note: row.note || "",
          address: "",
          latitude: 0,
          longitude: 0
        });
        state.places.push(place);
        existingPlaceNames[row.name] = true;
        placeCount += 1;
      } else {
        place = state.places.find(function (p) {
          return p.tripId === trip.id && p.name === row.name;
        });
      }
      if (!place) {
        return;
      }

      var alreadyOnDay = state.itineraryItems.some(function (item) {
        return item.tripId === trip.id && item.placeId === place.id && item.date === row.date;
      });
      if (alreadyOnDay) {
        return;
      }

      var order =
        state.itineraryItems.filter(function (item) {
          return item.tripId === trip.id && item.date === row.date;
        }).length + 1;

      state.itineraryItems.push({
        id: uid("itin"),
        tripId: trip.id,
        placeId: place.id,
        date: row.date,
        plannedTime: row.time || "",
        order: order,
        completed: false,
        distanceFromPrevious: "",
        durationFromPrevious: "",
        note: row.note || ""
      });
      stopCount += 1;
    });

    if (placeCount || stopCount) {
      TravelStorage.setPlaces(state.places);
      TravelStorage.setItineraryItems(state.itineraryItems);
    }

    (plan.todos || []).forEach(function (row) {
      if (!row || !row.title || !row.date) {
        return;
      }
      if (row.date < trip.startDate || row.date > trip.endDate) {
        return;
      }
      var key = row.date + "|" + row.title;
      if (existingTodoKeys[key]) {
        return;
      }
      existingTodoKeys[key] = true;
      addTodo(
        alignTodoScheduleFields({
          title: row.title,
          dueDate: row.date,
          tripDay: tripDayFromDate(trip, row.date) || "",
          category: row.category || "during",
          priority: "medium",
          note: row.note || "",
          completed: false
        })
      );
      todoCount += 1;
    });

    refreshTripAgendaViews();
    return { placeCount: placeCount, stopCount: stopCount, todoCount: todoCount };
  }

  function bindAiEvents() {
    var settingsBtn = document.getElementById("aiSettingsBtn");
    var settingsDialog = document.getElementById("aiSettingsDialog");
    var settingsForm = document.getElementById("aiSettingsForm");
    var planBtn = document.getElementById("aiPlanBtn");
    var chatForm = document.getElementById("aiChatForm");
    var chatInput = document.getElementById("aiChatInput");
    var chatSend = document.getElementById("aiChatSend");
    var customPrefInput = document.getElementById("aiCustomPrefInput");
    var customPrefAdd = document.getElementById("aiCustomPrefAdd");

    if (!settingsBtn || !window.TravelAI) {
      return;
    }

    if (customPrefAdd && customPrefInput) {
      function handleAddCustomPref() {
        if (addCustomAiPreference(customPrefInput.value)) {
          customPrefInput.value = "";
          customPrefInput.focus();
        }
      }
      customPrefAdd.addEventListener("click", handleAddCustomPref);
      customPrefInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          handleAddCustomPref();
        }
      });
    }

    settingsBtn.addEventListener("click", function () {
      var settings = window.TravelAI.loadSettings();
      document.getElementById("aiSettingApiKey").value = settings.apiKey || "";
      document.getElementById("aiSettingBaseUrl").value = settings.baseUrl || "";
      document.getElementById("aiSettingModel").value = settings.model || "";
      settingsDialog.showModal();
    });

    settingsForm.addEventListener("submit", function (event) {
      var submitter = event.submitter;
      if (submitter && submitter.value === "save") {
        window.TravelAI.saveSettings({
          apiKey: document.getElementById("aiSettingApiKey").value.trim(),
          baseUrl: document.getElementById("aiSettingBaseUrl").value.trim() || "https://api.deepseek.com/v1",
          model: document.getElementById("aiSettingModel").value.trim() || "deepseek-chat"
        });
        refreshAiStatus();
        appendAiBubble("ai", t("ai.saved"));
      }
    });

    planBtn.addEventListener("click", function () {
      var ctx = buildAiTripContext();
      if (!ctx) {
        return;
      }
      var catalog = getAiCatalogOptions();
      if (!catalog.preferences.length) {
        appendAiBubble("ai", t("ai.needPref"));
        return;
      }
      planBtn.disabled = true;
      var typing = appendAiBubble("ai", t("ai.generating"), "typing");
      window.TravelAI.generatePlan({
        trip: ctx.trip,
        places: ctx.places,
        todos: ctx.todos,
        focusDate: "",
        preferences: catalog.preferences,
        pace: catalog.pace,
        daysLabel: catalog.daysLabel
      }).then(function (result) {
        if (typing) {
          typing.remove();
        }
        renderAiAdvice(result.advice, result.mode, result.model);
        var counts = applyAiPlan(result.plan);
        var sourceLabel = formatAiSourceLabel(result.mode, result.model);
        appendAiBubble(
          "ai",
          t("ai.applied", {
            places: counts.placeCount,
            stops: counts.stopCount,
            todos: counts.todoCount
          }) + (result.error ? "（" + result.error + "）" : ""),
          "",
          { label: sourceLabel }
        );
        if (result.mode === "live") {
          setAiStatus("live", result.model || "");
        } else if (result.mode === "offline") {
          setAiStatus("offline");
        } else {
          setAiStatus("mock");
        }
      }).catch(function () {
        if (typing) {
          typing.remove();
        }
        appendAiBubble("ai", t("ai.failPlan"), "", { label: formatAiSourceLabel("mock") });
      }).finally(function () {
        planBtn.disabled = false;
      });
    });

    chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var ctx = buildAiTripContext();
      if (!ctx) {
        return;
      }
      var text = chatInput.value.trim();
      if (!text) {
        return;
      }
      appendAiBubble("user", text);
      aiChatHistory.push({ role: "user", content: text });
      chatInput.value = "";
      chatSend.disabled = true;
      var typing = appendAiBubble("ai", t("ai.thinking"), "typing");

      window.TravelAI.chat({
        message: text,
        trip: ctx.trip,
        places: ctx.places,
        todos: ctx.todos,
        history: aiChatHistory.slice(0, -1)
      }).then(function (result) {
        if (typing) {
          typing.remove();
        }
        appendAiBubble("ai", result.reply, "", {
          label: formatAiSourceLabel(result.mode, result.model),
          question: text
        });
        aiChatHistory.push({ role: "assistant", content: result.reply });
        if (result.mode === "live") {
          setAiStatus("live", result.model || "");
        } else if (result.mode === "offline") {
          setAiStatus("offline");
        } else {
          setAiStatus("mock");
        }
      }).catch(function () {
        if (typing) {
          typing.remove();
        }
        appendAiBubble("ai", t("ai.failChat"), "", {
          label: formatAiSourceLabel("mock"),
          question: text
        });
      }).finally(function () {
        chatSend.disabled = false;
        chatInput.focus();
      });
    });
  }

  function setStatusPill(el, status) {
    if (!el) {
      return;
    }
    el.textContent = t("status." + status);
    el.className = "status-pill status-" + status;
  }

  /* ---------- Dashboard ---------- */

  function renderDashboard() {
    var empty = document.getElementById("dashboardEmpty");
    var content = document.getElementById("dashboardContent");
    var featured = getFeaturedTrip();

    if (!featured) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }

    empty.hidden = true;
    content.hidden = false;
    state.currentTripId = featured.id;
    TravelStorage.setCurrentTripId(featured.id);

    var status = getTripStatus(featured);
    document.getElementById("dashTripName").textContent = featured.name;
    document.getElementById("dashDestination").textContent = featured.destination;
    document.getElementById("dashDates").textContent = featured.startDate + " → " + featured.endDate;
    document.getElementById("dashCountdown").textContent = countdownText(featured);
    setStatusPill(document.getElementById("dashStatus"), status);
    applyCoverStyle(document.getElementById("dashCover"), featured);

    var todos = forTrip(state.todos, featured.id);
    var today = todayStr();
    var todayTodos = todos.filter(function (todo) {
      return todo.dueDate === today;
    });
    renderSimpleList("dashTodayList", "dashTodayEmpty", todayTodos, function (todo) {
      return todo.title + (todo.completed ? " · " + t("label.completed") : "");
    });

    var upcoming = todos
      .filter(function (todo) {
        return !todo.completed && todo.dueDate && todo.dueDate >= today;
      })
      .sort(function (a, b) {
        return a.dueDate.localeCompare(b.dueDate);
      })
      .slice(0, 5);
    renderSimpleList("dashTodoList", "dashTodoEmpty", upcoming, function (todo) {
      return todo.title + " · " + todo.dueDate;
    });

    var done = todos.filter(function (todo) {
      return todo.completed;
    }).length;
    document.getElementById("dashTodoProgress").textContent = done + "/" + todos.length;
    var pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
    document.getElementById("dashTodoBar").style.width = pct + "%";

    document.getElementById("dashPlaceCount").textContent = String(forTrip(state.places, featured.id).length);
    document.getElementById("dashNoteCount").textContent = String(forTrip(state.notes, featured.id).length);
    document.getElementById("dashPhotoCount").textContent = String(forTrip(state.photos, featured.id).length);

    var notes = forTrip(state.notes, featured.id)
      .slice()
      .sort(function (a, b) {
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      })
      .slice(0, 3);
    renderSimpleList("dashNotesList", "dashNotesEmpty", notes, function (note) {
      return note.content;
    });

    var photos = forTrip(state.photos, featured.id).slice(0, 4);
    var photoRow = document.getElementById("dashPhotosList");
    var photoEmpty = document.getElementById("dashPhotosEmpty");
    photoRow.innerHTML = "";
    photoEmpty.hidden = photos.length > 0;
    photos.forEach(function (photo) {
      var fig = document.createElement("figure");
      fig.className = "dash-photo";
      if (photo.imageUrl) {
        var img = document.createElement("img");
        img.src = photo.imageUrl;
        img.alt = photo.title;
        fig.appendChild(img);
      }
      var cap = document.createElement("figcaption");
      cap.textContent = photo.title;
      fig.appendChild(cap);
      photoRow.appendChild(fig);
    });
  }

  function renderSimpleList(listId, emptyId, items, labelFn) {
    var list = document.getElementById(listId);
    var empty = document.getElementById(emptyId);
    list.innerHTML = "";
    empty.hidden = items.length > 0;
    items.forEach(function (item) {
      var row = document.createElement("article");
      row.className = "list-item";
      row.innerHTML = "<div><p></p></div>";
      row.querySelector("p").textContent = labelFn(item);
      list.appendChild(row);
    });
  }

  /* ---------- Trip cards ---------- */

  function renderTripCards() {
    var grid = document.getElementById("tripCardGrid");
    var empty = document.getElementById("tripEmpty");
    grid.innerHTML = "";

    if (!state.trips.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    state.trips
      .slice()
      .sort(function (a, b) {
        return b.startDate.localeCompare(a.startDate);
      })
      .forEach(function (trip) {
        var status = getTripStatus(trip);
        var card = document.createElement("article");
        card.className = "trip-card";
        card.innerHTML =
          '<div class="trip-card-cover"></div>' +
          '<div class="trip-card-body">' +
          '<span class="status-pill"></span>' +
          "<h3></h3>" +
          '<p class="dest"></p>' +
          '<p class="dates"></p>' +
          '<div class="item-actions">' +
          '<button type="button" class="btn primary small open-trip"></button>' +
          '<button type="button" class="btn small edit-trip"></button>' +
          '<button type="button" class="btn small danger delete-trip"></button>' +
          "</div></div>";

        applyCoverStyle(card.querySelector(".trip-card-cover"), trip);
        setStatusPill(card.querySelector(".status-pill"), status);
        card.querySelector("h3").textContent = trip.name;
        card.querySelector(".dest").textContent = trip.destination;
        card.querySelector(".dates").textContent = trip.startDate + " → " + trip.endDate;
        card.querySelector(".open-trip").textContent = t("btn.openTrip");
        card.querySelector(".edit-trip").textContent = t("btn.edit");
        card.querySelector(".delete-trip").textContent = t("btn.delete");

        card.querySelector(".trip-card-cover").addEventListener("click", function () {
          openTrip(trip.id, "overview");
        });
        card.querySelector("h3").addEventListener("click", function () {
          openTrip(trip.id, "overview");
        });
        card.querySelector(".open-trip").addEventListener("click", function () {
          openTrip(trip.id, "overview");
        });
        card.querySelector(".edit-trip").addEventListener("click", function (event) {
          event.stopPropagation();
          fillTripForm(trip);
          document.getElementById("tripFormPanel").hidden = false;
        });
        card.querySelector(".delete-trip").addEventListener("click", function (event) {
          event.stopPropagation();
          if (!confirm(t("msg.confirmDeleteTrip"))) {
            return;
          }
          deleteTrip(trip.id);
        });

        grid.appendChild(card);
      });
  }

  function fillTripForm(trip) {
    var normalized = normalizeTripCover(Object.assign({}, trip));
    document.getElementById("tripFormTitle").setAttribute("data-i18n", "trips.editTitle");
    document.getElementById("tripFormTitle").textContent = t("trips.editTitle");
    document.getElementById("tripId").value = trip.id;
    document.getElementById("tripName").value = trip.name;
    document.getElementById("tripDestination").value = trip.destination;
    document.getElementById("tripStart").value = trip.startDate;
    document.getElementById("tripEnd").value = trip.endDate;
    editCoverState = {
      coverType: normalized.coverType || "gradient",
      coverImage: normalized.coverImage || "",
      coverPreset: normalized.coverPreset || "sunset",
      coverPosition: normalized.coverPosition || "center"
    };
    renderCoverPicker("editCoverPicker", editCoverState);
  }

  function resetTripForm() {
    document.getElementById("tripForm").reset();
    document.getElementById("tripId").value = "";
    document.getElementById("tripFormTitle").setAttribute("data-i18n", "trips.editTitle");
    document.getElementById("tripFormTitle").textContent = t("trips.editTitle");
    document.getElementById("tripFormPanel").hidden = true;
    editCoverState = defaultCoverFields();
  }

  function deleteTrip(tripId) {
    state.trips = state.trips.filter(function (trip) {
      return trip.id !== tripId;
    });
    state.places = state.places.filter(function (item) {
      return item.tripId !== tripId;
    });
    state.itineraryItems = state.itineraryItems.filter(function (item) {
      return item.tripId !== tripId;
    });
    state.todos = state.todos.filter(function (item) {
      return item.tripId !== tripId;
    });
    state.notes = state.notes.filter(function (item) {
      return item.tripId !== tripId;
    });
    state.photos = state.photos.filter(function (item) {
      return item.tripId !== tripId;
    });
    if (state.currentTripId === tripId) {
      state.currentTripId = state.trips[0] ? state.trips[0].id : "";
    }
    persistAll();
    resetTripForm();
    if (state.appView === "trip") {
      showAppView("trips");
    } else {
      renderTripCards();
      renderDashboard();
    }
  }

  /* ---------- Workspace ---------- */

  function renderWorkspace() {
    var trip = getCurrentTrip();
    if (!trip) {
      showAppView("trips");
      return;
    }
    document.getElementById("workspaceTripName").textContent = trip.name;
    document.getElementById("workspaceDestination").textContent = trip.destination;
    document.getElementById("workspaceDates").textContent =
      trip.startDate + " → " + trip.endDate + " · " + t("label.daysCount", { n: tripDurationDays(trip) });
    setStatusPill(document.getElementById("workspaceStatus"), getTripStatus(trip));
    fillTripDayOptions();
    renderOverview();
    renderTodos();
    renderCalendar();
    renderGuide();
    renderFavorites();
  }

  function fillTripDayOptions() {
    var select = document.getElementById("todoTripDay");
    if (!select) {
      return;
    }
    var trip = getCurrentTrip();
    var current = select.value;
    select.innerHTML = "";
    var none = document.createElement("option");
    none.value = "";
    none.setAttribute("data-i18n", "todo.noTripDay");
    none.textContent = t("todo.noTripDay");
    select.appendChild(none);
    if (!trip) {
      return;
    }
    var days = tripDurationDays(trip);
    for (var d = 1; d <= days; d++) {
      var opt = document.createElement("option");
      opt.value = String(d);
      opt.textContent = t("todo.dayN", { n: d });
      select.appendChild(opt);
    }
    if (current) {
      select.value = current;
    }
  }

  function renderOverview() {
    var trip = getCurrentTrip();
    if (!trip) {
      return;
    }
    var cover = document.getElementById("overviewCover");
    if (!cover) {
      return;
    }
    applyCoverStyle(cover, trip);
    document.getElementById("ovTripTitle").textContent = trip.name;
    document.getElementById("ovDestination").textContent = trip.destination;
    document.getElementById("ovStartDate").textContent = trip.startDate;
    document.getElementById("ovEndDate").textContent = trip.endDate;
    document.getElementById("ovDuration").textContent = t("label.daysCount", { n: tripDurationDays(trip) });
    setStatusPill(document.getElementById("ovStatus"), getTripStatus(trip));
    document.getElementById("ovCountdown").textContent = countdownText(trip);

    var stylesEl = document.getElementById("ovStyles");
    stylesEl.innerHTML = "";
    (trip.styles || []).forEach(function (key) {
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = t("style." + key);
      stylesEl.appendChild(chip);
    });
    if (!(trip.styles && trip.styles.length)) {
      var emptyStyle = document.createElement("span");
      emptyStyle.className = "hint";
      emptyStyle.textContent = t("overview.noStyles");
      stylesEl.appendChild(emptyStyle);
    }

    // Only todos for THIS trip.
    var todos = getTodosByTripId(trip.id);
    var done = todos.filter(function (todo) {
      return todo.completed;
    }).length;
    document.getElementById("ovTodoCount").textContent = done + "/" + todos.length;
    var pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
    document.getElementById("ovTodoBar").style.width = pct + "%";

    document.getElementById("ovPlaceCount").textContent = String(forTrip(state.places, trip.id).length);
    document.getElementById("ovPhotoCount").textContent = String(forTrip(state.photos, trip.id).length);

    var today = todayStr();
    var upcoming = todos
      .filter(function (todo) {
        return !todo.completed && todo.dueDate && todo.dueDate >= today;
      })
      .sort(function (a, b) {
        return a.dueDate.localeCompare(b.dueDate);
      })
      .slice(0, 4);
    renderSimpleList("ovUpcomingList", "ovUpcomingEmpty", upcoming, function (todo) {
      return todo.title + " · " + todo.dueDate;
    });

    var todayAgenda = getDayAgenda(trip.id, today);
    renderSimpleList("ovTodayList", "ovTodayEmpty", todayAgenda, function (entry) {
      return (
        (entry.kind === "place" ? t("guide.placeStop") + " · " : "") +
        entry.title +
        (entry.completed ? " · " + t("label.completed") : "")
      );
    });

    var notes = forTrip(state.notes, trip.id)
      .slice()
      .sort(function (a, b) {
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      })
      .slice(0, 3);
    renderSimpleList("ovNotesList", "ovNotesEmpty", notes, function (note) {
      return note.content;
    });
  }

  function renderPlaces() {
    // Map route planner lives in map-route.js (TravelMapRoute).
  }

  function resetPlaceForm() {}

  function fillTodoForm(todo) {
    document.getElementById("todoId").value = todo.id;
    document.getElementById("todoTitle").value = todo.title;
    document.getElementById("todoDue").value = todo.dueDate || "";
    document.getElementById("todoPriority").value = todo.priority || "medium";
    document.getElementById("todoCategory").value = todo.category || "during";
    document.getElementById("todoTripDay").value =
      todo.tripDay === 0 || todo.tripDay ? String(todo.tripDay) : "";
    document.getElementById("todoNote").value = todo.note || "";
    var submitBtn = document.getElementById("todoSubmitBtn");
    if (submitBtn) {
      submitBtn.textContent = t("btn.saveTodo");
    }
  }

  function openTodoEditor(todo) {
    fillTripDayOptions();
    setTripTab("todo");
    fillTodoForm(todo);
    document.getElementById("todoTitle").focus();
  }

  function renderTodos() {
    var list = document.getElementById("todoList");
    var empty = document.getElementById("todoEmpty");
    if (!list || !empty) {
      return;
    }
    // Filter: only the current trip's todos.
    var todos = getTodosByTripId(state.currentTripId);
    list.innerHTML = "";
    empty.hidden = todos.length > 0;

    todos
      .slice()
      .sort(function (a, b) {
        return (a.dueDate || "").localeCompare(b.dueDate || "");
      })
      .forEach(function (todo) {
        var item = document.createElement("article");
        item.className = "list-item";
        item.innerHTML =
          "<div class='todo-row'>" +
          "<input type='checkbox' class='todo-check'>" +
          "<div><h3></h3><p></p><div class='meta'>" +
          "<span class='chip priority'></span>" +
          "<span class='chip category'></span>" +
          "<span class='chip trip-day' hidden></span>" +
          "<span class='chip done-chip' hidden></span>" +
          "</div></div></div>" +
          "<div class='item-actions'>" +
          "<button type='button' class='btn small edit-todo'></button>" +
          "<button type='button' class='btn small danger delete-todo'></button>" +
          "</div>";

        var row = item.querySelector(".todo-row");
        if (todo.completed) {
          row.classList.add("completed");
        }
        item.querySelector("h3").textContent = todo.title;
        var detailParts = [];
        if (todo.dueDate) {
          detailParts.push(todo.dueDate);
        }
        if (todo.note) {
          detailParts.push(todo.note);
        }
        item.querySelector("p").textContent = detailParts.join(" · ") || "-";
        item.querySelector(".priority").textContent = t("priority." + todo.priority);
        item.querySelector(".priority").classList.add("priority-" + todo.priority);
        item.querySelector(".category").textContent = t("todo." + todo.category);
        var dayChip = item.querySelector(".trip-day");
        if (todo.tripDay) {
          dayChip.hidden = false;
          dayChip.textContent = t("todo.dayN", { n: todo.tripDay });
        }
        var doneChip = item.querySelector(".done-chip");
        doneChip.textContent = t("label.completed");
        doneChip.hidden = !todo.completed;
        if (todo.completed) {
          doneChip.classList.add("done");
        }
        var checkbox = item.querySelector(".todo-check");
        checkbox.checked = !!todo.completed;
        checkbox.addEventListener("change", function () {
          updateTodo(todo.id, { completed: checkbox.checked });
          refreshTodoViews();
        });
        item.querySelector(".edit-todo").textContent = t("btn.edit");
        item.querySelector(".delete-todo").textContent = t("btn.delete");
        item.querySelector(".edit-todo").addEventListener("click", function () {
          fillTodoForm(todo);
        });
        item.querySelector(".delete-todo").addEventListener("click", function () {
          if (!confirm(t("msg.confirmDelete"))) {
            return;
          }
          deleteTodo(todo.id);
          refreshTodoViews();
        });
        list.appendChild(item);
      });
  }

  function resetTodoForm() {
    document.getElementById("todoForm").reset();
    document.getElementById("todoId").value = "";
    document.getElementById("todoPriority").value = "medium";
    document.getElementById("todoTripDay").value = "";
    var submitBtn = document.getElementById("todoSubmitBtn");
    if (submitBtn) {
      submitBtn.textContent = t("btn.addTodo");
    }
  }

  function renderCalendar() {
    var calendar = document.getElementById("calendar");
    var title = document.getElementById("calendarTitle");
    if (!calendar || !title) {
      return;
    }
    var year = state.calendarYear;
    var month = state.calendarMonth;
    title.textContent = year + "-" + String(month + 1).padStart(2, "0");
    calendar.innerHTML = "";

    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].forEach(function (key) {
      var cell = document.createElement("div");
      cell.className = "cal-weekday";
      cell.textContent = t("week." + key);
      calendar.appendChild(cell);
    });

    var firstDay = new Date(year, month, 1);
    var startWeekday = firstDay.getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var prevDays = new Date(year, month, 0).getDate();
    var today = todayStr();

    function addCell(day, inMonth, dateStr) {
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-cell";
      if (!inMonth) {
        cell.classList.add("muted");
      }
      if (dateStr === today) {
        cell.classList.add("today");
      }
      if (dateStr === state.selectedDate) {
        cell.classList.add("selected");
      }
      var dayEl = document.createElement("span");
      dayEl.className = "cal-day";
      dayEl.textContent = String(day);
      cell.appendChild(dayEl);

      // Same-day agenda: map stops + todos.
      var agenda = getDayAgenda(state.currentTripId, dateStr);
      agenda.slice(0, 3).forEach(function (entry) {
        var task = document.createElement("span");
        var classes = "cal-task";
        if (entry.kind === "place") {
          classes += " is-place";
        }
        if (entry.completed) {
          classes += " is-done";
        }
        if (entry.priority === "high") {
          classes += " is-high";
        }
        task.className = classes;
        task.textContent = (entry.kind === "place" ? "📍 " : "") + entry.title;
        cell.appendChild(task);
      });
      if (agenda.length > 3) {
        var more = document.createElement("span");
        more.className = "cal-task";
        more.textContent = "+" + (agenda.length - 3);
        cell.appendChild(more);
      }
      cell.addEventListener("click", function () {
        state.selectedDate = dateStr;
        renderCalendar();
        renderDayTodos();
      });
      calendar.appendChild(cell);
    }

    for (var i = startWeekday - 1; i >= 0; i--) {
      addCell(prevDays - i, false, formatDate(new Date(year, month - 1, prevDays - i)));
    }
    for (var d = 1; d <= daysInMonth; d++) {
      addCell(d, true, formatDate(new Date(year, month, d)));
    }
    var totalCells = startWeekday + daysInMonth;
    var nextCount = (7 - (totalCells % 7)) % 7;
    for (var n = 1; n <= nextCount; n++) {
      addCell(n, false, formatDate(new Date(year, month + 1, n)));
    }
    renderDayTodos();
  }

  function renderDayTodos() {
    var list = document.getElementById("dayTodoList");
    var empty = document.getElementById("dayTodoEmpty");
    var label = document.getElementById("selectedDateLabel");
    if (!list || !empty || !label) {
      return;
    }
    label.textContent = state.selectedDate;
    label.removeAttribute("data-i18n");
    var agenda = getDayAgenda(state.currentTripId, state.selectedDate);
    list.innerHTML = "";
    empty.hidden = agenda.length > 0;

    agenda.forEach(function (entry) {
      var item = document.createElement("article");
      item.className =
        "list-item" +
        (entry.completed ? " is-completed" : "") +
        (entry.kind === "place" ? " is-place-item" : "");
      item.innerHTML =
        "<div><h3></h3><p></p></div>" +
        "<div class='item-actions'>" +
        "<button type='button' class='btn small open-agenda'></button>" +
        "</div>";
      item.querySelector("h3").textContent =
        (entry.kind === "place" ? t("guide.placeStop") + " · " : t("guide.todoItem") + " · ") +
        entry.title;
      item.querySelector("p").textContent = [
        entry.time,
        entry.kind === "todo" ? t("todo." + entry.category) : t("place." + entry.category),
        entry.note,
        entry.completed ? t("label.completed") : ""
      ]
        .filter(Boolean)
        .join(" · ");

      var openBtn = item.querySelector(".open-agenda");
      openBtn.textContent = entry.kind === "place" ? t("tab.map") : t("btn.edit");
      openBtn.addEventListener("click", function () {
        if (entry.kind === "place") {
          openTrip(state.currentTripId, "map");
          if (TravelMapRoute && TravelMapRoute.focusDate) {
            TravelMapRoute.focusDate(state.selectedDate);
          }
        } else {
          setTripTab("todo");
          var todo = state.todos.find(function (row) {
            return row.id === entry.id;
          });
          if (todo) {
            fillTodoForm(todo);
          }
        }
      });
      list.appendChild(item);
    });
  }

  function renderGuide() {
    var list = document.getElementById("guideDayList");
    var empty = document.getElementById("guideEmpty");
    var trip = getCurrentTrip();
    if (!list || !empty) {
      return;
    }
    list.innerHTML = "";
    if (!trip) {
      empty.hidden = false;
      return;
    }

    var start = parseDate(trip.startDate);
    var end = parseDate(trip.endDate);
    if (!start || !end) {
      empty.hidden = false;
      return;
    }

    var hasAny = false;
    var dayIndex = 1;
    for (
      var cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      cursor <= end;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    ) {
      var dateStr = formatDate(cursor);
      var agenda = getDayAgenda(trip.id, dateStr);
      if (agenda.length) {
        hasAny = true;
      }

      var card = document.createElement("section");
      card.className = "guide-day-card";
      card.innerHTML =
        "<div class='guide-day-head'>" +
        "<div><h4></h4><p></p></div>" +
        "<div class='guide-day-actions'>" +
        "<button type='button' class='btn small guide-to-map'></button>" +
        "<button type='button' class='btn small guide-to-todo'></button>" +
        "</div></div>" +
        "<div class='guide-day-items'></div>";

      card.querySelector("h4").textContent = t("todo.dayN", { n: dayIndex });
      card.querySelector("p").textContent = dateStr + " · " + t("guide.itemCount", { n: agenda.length });
      card.querySelector(".guide-to-map").textContent = t("tab.map");
      card.querySelector(".guide-to-todo").textContent = t("tab.todo");

      (function (dateForDay) {
        card.querySelector(".guide-to-map").addEventListener("click", function () {
          setTripTab("map");
          if (TravelMapRoute && TravelMapRoute.focusDate) {
            TravelMapRoute.focusDate(dateForDay);
          }
        });
        card.querySelector(".guide-to-todo").addEventListener("click", function () {
          setTripTab("todo");
        });
      })(dateStr);

      var itemsEl = card.querySelector(".guide-day-items");
      if (!agenda.length) {
        var blank = document.createElement("p");
        blank.className = "hint";
        blank.textContent = t("guide.dayEmpty");
        itemsEl.appendChild(blank);
      } else {
        agenda.forEach(function (entry) {
          var row = document.createElement("div");
          row.className = "guide-item" + (entry.completed ? " is-done" : "");
          row.innerHTML =
            "<button type='button' class='guide-item-main'>" +
            "<span class='guide-item-kind'></span>" +
            "<span class='guide-item-body'><strong></strong><em></em></span></button>" +
            (entry.kind === "place" ? "<button type='button' class='btn small favorite-toggle'></button>" : "");
          row.querySelector(".guide-item-kind").textContent =
            entry.kind === "place" ? t("guide.placeStop") : t("guide.todoItem");
          row.querySelector("strong").textContent =
            (entry.time ? entry.time + " · " : "") + entry.title;
          row.querySelector("em").textContent = entry.note || "";
          (function (agendaEntry, dateForDay) {
            row.querySelector(".guide-item-main").addEventListener("click", function () {
              if (agendaEntry.kind === "place") {
                setTripTab("map");
                if (TravelMapRoute && TravelMapRoute.focusDate) {
                  TravelMapRoute.focusDate(dateForDay);
                }
              } else {
                setTripTab("todo");
                var todo = state.todos.find(function (rowTodo) {
                  return rowTodo.id === agendaEntry.id;
                });
                if (todo) {
                  fillTodoForm(todo);
                }
              }
            });
          })(entry, dateStr);
          if (entry.kind === "place") {
            var favoriteBtn = row.querySelector(".favorite-toggle");
            var favorite = findFavorite(trip.id, entry.placeId);
            favoriteBtn.textContent = favorite ? "♥ 已收藏" : "♡ 收藏";
            favoriteBtn.classList.toggle("is-favorite", !!favorite);
            favoriteBtn.setAttribute("aria-pressed", favorite ? "true" : "false");
            (function (agendaEntry, dateForDay) {
              favoriteBtn.addEventListener("click", function () {
                toggleFavorite(agendaEntry, dateForDay);
              });
            })(entry, dateStr);
          }
          itemsEl.appendChild(row);
        });
      }

      list.appendChild(card);
      dayIndex += 1;
    }

    empty.hidden = hasAny;
  }

  function renderNotes() {
    // Notes feature is a placeholder in this phase.
  }

  function resetNoteForm() {}

  function renderPhotos() {
    // Gallery feature is a placeholder in this phase.
  }

  function resetPhotoForm() {}

  function createPhotoFallback(title) {
    var fallback = document.createElement("div");
    fallback.className = "photo-fallback";
    fallback.textContent = title || "Photo";
    return fallback;
  }

  function showToast(id) {
    var el = document.getElementById(id);
    if (!el) {
      return;
    }
    el.hidden = false;
    setTimeout(function () {
      el.hidden = true;
    }, 1500);
  }

  function renderAllVisible() {
    if (state.appView === "home") {
      renderDashboard();
    } else if (state.appView === "trips") {
      renderTripCards();
    } else if (state.appView === "trip") {
      renderWorkspace();
      setTripTab(state.tripTab);
    } else if (state.appView === "create") {
      renderWizard();
    }
  }

  /* ---------- Create Journey Wizard ---------- */

  function renderWizard() {
    var step = state.wizardStep;
    document.querySelectorAll(".wizard-step").forEach(function (el) {
      el.classList.toggle("is-active", Number(el.getAttribute("data-wizard-step")) === step);
    });
    document.querySelectorAll("[data-step-dot]").forEach(function (dot) {
      var n = Number(dot.getAttribute("data-step-dot"));
      dot.classList.toggle("is-active", n === step);
      dot.classList.toggle("is-done", n < step);
    });
    document.getElementById("wizardStepLabel").textContent = step + " / 5";
    document.getElementById("wizardBack").hidden = step === 1;
    document.getElementById("wizardNext").hidden = step === 5;
    document.getElementById("wizardCreate").hidden = step !== 5;

    renderWizardDestination();
    renderWizardDates();
    renderWizardStyles();
    renderCoverPicker("wizardCoverPicker", state.wizard, function () {
      // live update only
    });
    if (step === 5) {
      renderWizardSummary();
    }
  }

  function renderWizardDestination() {
    var hero = document.getElementById("wizardHeroDestination");
    var value = state.wizard.destination.trim();
    if (value) {
      hero.textContent = value;
      hero.classList.add("has-value");
      hero.classList.remove("is-placeholder");
      hero.removeAttribute("data-i18n");
    } else {
      hero.setAttribute("data-i18n", "wizard.destinationPreview");
      hero.textContent = t("wizard.destinationPreview");
      hero.classList.add("is-placeholder");
      hero.classList.remove("has-value");
    }

    var box = document.getElementById("wizardSuggestions");
    box.innerHTML = "";
    SUGGEST_KEYS.forEach(function (key) {
      var label = t(key);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wizard-chip" + (state.wizard.destination === label ? " is-active" : "");
      btn.textContent = label;
      btn.addEventListener("click", function () {
        state.wizard.destination = label;
        document.getElementById("wizardDestination").value = label;
        renderWizardDestination();
      });
      box.appendChild(btn);
    });
  }

  function renderWizardDates() {
    var start = state.wizard.startDate;
    var end = state.wizard.endDate;
    var rangeEl = document.getElementById("wizardDateRange");
    var daysEl = document.getElementById("wizardDurationDays");
    if (start && end && end >= start) {
      rangeEl.textContent = formatDisplayDate(start) + " → " + formatDisplayDate(end);
      daysEl.textContent = t("wizard.days", { n: tripDurationDays(start, end) });
    } else {
      rangeEl.setAttribute("data-i18n", "wizard.pickDates");
      rangeEl.textContent = t("wizard.pickDates");
      daysEl.textContent = "";
    }
  }

  function renderWizardStyles() {
    var grid = document.getElementById("wizardStyleGrid");
    grid.innerHTML = "";
    STYLE_OPTIONS.forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "wizard-style-tag" + (state.wizard.styles.indexOf(key) >= 0 ? " is-selected" : "");
      btn.textContent = t("style." + key);
      btn.addEventListener("click", function () {
        var idx = state.wizard.styles.indexOf(key);
        if (idx >= 0) {
          state.wizard.styles.splice(idx, 1);
        } else {
          state.wizard.styles.push(key);
        }
        renderWizardStyles();
      });
      grid.appendChild(btn);
    });
  }

  function renderCoverPicker(containerId, coverState, onChange) {
    var root = document.getElementById(containerId);
    if (!root) {
      return;
    }
    root.innerHTML = "";

    var typeRow = document.createElement("div");
    typeRow.className = "cover-type-row";
    var typeLabel = document.createElement("p");
    typeLabel.className = "ui-label";
    typeLabel.setAttribute("data-i18n", "cover.typeLabel");
    typeLabel.textContent = t("cover.typeLabel");
    typeRow.appendChild(typeLabel);

    var typeButtons = document.createElement("div");
    typeButtons.className = "cover-type-tabs";
    ["image", "url", "gradient"].forEach(function (type) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cover-type-tab" + (coverState.coverType === type ? " is-active" : "");
      btn.setAttribute("data-i18n", "cover.type" + type.charAt(0).toUpperCase() + type.slice(1));
      btn.textContent = t(
        "cover.type" + type.charAt(0).toUpperCase() + type.slice(1)
      );
      btn.addEventListener("click", function () {
        coverState.coverType = type;
        if (type === "gradient" && !coverState.coverPreset) {
          coverState.coverPreset = "sunset";
        }
        renderCoverPicker(containerId, coverState, onChange);
        if (onChange) {
          onChange();
        }
      });
      typeButtons.appendChild(btn);
    });
    typeRow.appendChild(typeButtons);
    root.appendChild(typeRow);

    var preview = document.createElement("div");
    preview.className = "cover-live-preview";
    preview.setAttribute("aria-label", t("cover.preview"));
    applyCoverStyle(preview, coverState);
    root.appendChild(preview);

    if (coverState.coverType === "image") {
      var uploadWrap = document.createElement("div");
      uploadWrap.className = "cover-upload";
      var hint = document.createElement("p");
      hint.className = "ui-hint";
      hint.setAttribute("data-i18n", "cover.uploadHint");
      hint.textContent = t("cover.uploadHint");
      var fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.className = "ui-input";
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        readCoverFileAsPreview(
          file,
          function (dataUrl) {
            coverState.coverImage = dataUrl;
            coverState.coverType = "image";
            renderCoverPicker(containerId, coverState, onChange);
            if (onChange) {
              onChange();
            }
          },
          function (message) {
            alert(message);
            fileInput.value = "";
          }
        );
      });
      uploadWrap.appendChild(hint);
      uploadWrap.appendChild(fileInput);
      if (coverState.coverImage) {
        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ui-btn ui-btn--ghost ui-btn--sm";
        removeBtn.setAttribute("data-i18n", "cover.removeImage");
        removeBtn.textContent = t("cover.removeImage");
        removeBtn.addEventListener("click", function () {
          coverState.coverImage = "";
          renderCoverPicker(containerId, coverState, onChange);
          if (onChange) {
            onChange();
          }
        });
        uploadWrap.appendChild(removeBtn);
      }
      root.appendChild(uploadWrap);
    }

    if (coverState.coverType === "url") {
      var urlField = document.createElement("label");
      urlField.className = "ui-field";
      var urlLabel = document.createElement("span");
      urlLabel.className = "ui-label";
      urlLabel.setAttribute("data-i18n", "cover.urlLabel");
      urlLabel.textContent = t("cover.urlLabel");
      var urlInput = document.createElement("input");
      urlInput.className = "ui-input";
      urlInput.type = "url";
      urlInput.value = coverState.coverImage || "";
      urlInput.setAttribute("data-i18n-placeholder", "cover.urlPh");
      urlInput.placeholder = t("cover.urlPh");
      urlInput.addEventListener("input", function () {
        coverState.coverImage = urlInput.value.trim();
        applyCoverStyle(preview, coverState);
        if (onChange) {
          onChange();
        }
      });
      urlField.appendChild(urlLabel);
      urlField.appendChild(urlInput);
      root.appendChild(urlField);
    }

    if (coverState.coverType === "gradient") {
      var presetLabel = document.createElement("p");
      presetLabel.className = "ui-label";
      presetLabel.setAttribute("data-i18n", "cover.presetLabel");
      presetLabel.textContent = t("cover.presetLabel");
      root.appendChild(presetLabel);
      var presetGrid = document.createElement("div");
      presetGrid.className = "wizard-cover-grid";
      COVER_PRESETS.forEach(function (key) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "wizard-cover-option" + (coverState.coverPreset === key ? " is-selected" : "");
        btn.innerHTML =
          '<span class="wizard-cover-preview cover-preset-' +
          key +
          '"></span><span></span>';
        btn.querySelectorAll("span")[1].textContent = t("preset." + key);
        btn.addEventListener("click", function () {
          coverState.coverPreset = key;
          coverState.coverType = "gradient";
          renderCoverPicker(containerId, coverState, onChange);
          if (onChange) {
            onChange();
          }
        });
        presetGrid.appendChild(btn);
      });
      root.appendChild(presetGrid);
    }

    if (coverState.coverType === "image" || coverState.coverType === "url") {
      var posLabel = document.createElement("p");
      posLabel.className = "ui-label";
      posLabel.setAttribute("data-i18n", "cover.positionLabel");
      posLabel.textContent = t("cover.positionLabel");
      root.appendChild(posLabel);
      var posRow = document.createElement("div");
      posRow.className = "cover-type-tabs";
      ["center", "top", "bottom"].forEach(function (pos) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "cover-type-tab" + (coverState.coverPosition === pos ? " is-active" : "");
        btn.setAttribute(
          "data-i18n",
          "cover.position" + pos.charAt(0).toUpperCase() + pos.slice(1)
        );
        btn.textContent = t(
          "cover.position" + pos.charAt(0).toUpperCase() + pos.slice(1)
        );
        btn.addEventListener("click", function () {
          coverState.coverPosition = pos;
          renderCoverPicker(containerId, coverState, onChange);
          if (onChange) {
            onChange();
          }
        });
        posRow.appendChild(btn);
      });
      root.appendChild(posRow);
    }
  }

  function renderWizardSummary() {
    var w = state.wizard;
    var cover = document.getElementById("wizardSummaryCover");
    cover.className = "wizard-summary-cover";
    applyCoverStyle(cover, w);
    document.getElementById("wizardSummaryDestination").textContent = w.destination;
    document.getElementById("wizardSummaryDates").textContent =
      formatDisplayDate(w.startDate) + " → " + formatDisplayDate(w.endDate);
    document.getElementById("wizardSummaryDuration").textContent = t("wizard.days", {
      n: tripDurationDays(w.startDate, w.endDate)
    });
    document.getElementById("wizardSummaryCoverName").textContent = coverLabel(w);

    var tags = document.getElementById("wizardSummaryStyles");
    tags.innerHTML = "";
    w.styles.forEach(function (key) {
      var tag = document.createElement("span");
      tag.className = "ui-tag";
      tag.textContent = t("style." + key);
      tags.appendChild(tag);
    });
  }

  function validateWizardStep(step) {
    if (step === 1 && !state.wizard.destination.trim()) {
      alert(t("wizard.needDestination"));
      return false;
    }
    if (step === 2) {
      if (!state.wizard.startDate || !state.wizard.endDate || state.wizard.endDate < state.wizard.startDate) {
        alert(t("wizard.needDates"));
        return false;
      }
    }
    if (step === 4) {
      if (state.wizard.coverType === "gradient" && !state.wizard.coverPreset) {
        alert(t("wizard.needCover"));
        return false;
      }
      if (
        (state.wizard.coverType === "image" || state.wizard.coverType === "url") &&
        !state.wizard.coverImage
      ) {
        // Fall back to gradient rather than blocking — user asked for readable fallback.
        state.wizard.coverType = "gradient";
        state.wizard.coverPreset = state.wizard.coverPreset || "sunset";
      }
    }
    return true;
  }

  function createJourneyFromWizard() {
    var w = state.wizard;
    if (!validateWizardStep(1) || !validateWizardStep(2) || !validateWizardStep(4)) {
      return;
    }
    var destination = w.destination.trim();
    var name = destination + t("wizard.tripNameSuffix");
    var coverType = w.coverType || "gradient";
    var coverImage = w.coverImage || "";
    var coverPreset = w.coverPreset || "sunset";
    if (coverType !== "gradient" && !coverImage) {
      coverType = "gradient";
    }
    var newTrip = {
      id: uid("trip"),
      name: name,
      destination: destination,
      startDate: w.startDate,
      endDate: w.endDate,
      coverType: coverType,
      coverImage: coverImage,
      coverPreset: coverPreset,
      coverPosition: w.coverPosition || "center",
      styles: w.styles.slice(),
      guide: "",
      summary: "",
      createdAt: todayStr()
    };
    state.trips.unshift(newTrip);
    state.currentTripId = newTrip.id;
    persistAll();
    openTrip(newTrip.id, "overview");
  }

  function bindEvents() {
    document.querySelectorAll("[data-app-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showAppView(btn.getAttribute("data-app-view"));
      });
    });

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        TravelI18n.setLanguage(btn.getAttribute("data-lang"));
        renderAllVisible();
        TravelMapRoute.onLanguageChange();
      });
    });

    document.querySelectorAll(".trip-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTripTab(btn.getAttribute("data-trip-tab"));
      });
    });

    document.getElementById("backToTrips").addEventListener("click", function () {
      showAppView("trips");
    });

    document.getElementById("clearFavoritesBtn").addEventListener("click", function () {
      if (!state.favorites.length || !confirm("确定清空全部收藏吗？")) {
        return;
      }
      state.favorites = [];
      if (saveFavorites()) {
        renderFavorites();
        renderGuide();
        refreshAiFavoriteButtons();
      }
    });

    ["dashCreateTrip", "dashEmptyCreate", "showTripFormBtn"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) {
        return;
      }
      el.addEventListener("click", function () {
        openCreateWizard();
      });
    });

    document.getElementById("wizardCancel").addEventListener("click", function () {
      showAppView("trips");
    });

    document.getElementById("wizardBack").addEventListener("click", function () {
      if (state.wizardStep > 1) {
        state.wizardStep -= 1;
        renderWizard();
      }
    });

    document.getElementById("wizardNext").addEventListener("click", function () {
      if (!validateWizardStep(state.wizardStep)) {
        return;
      }
      if (state.wizardStep < 5) {
        state.wizardStep += 1;
        renderWizard();
      }
    });

    document.getElementById("wizardCreate").addEventListener("click", function () {
      createJourneyFromWizard();
    });

    document.getElementById("wizardDestination").addEventListener("input", function (event) {
      state.wizard.destination = event.target.value;
      renderWizardDestination();
    });

    document.getElementById("wizardStart").addEventListener("change", function (event) {
      state.wizard.startDate = event.target.value;
      renderWizardDates();
    });

    document.getElementById("wizardEnd").addEventListener("change", function (event) {
      state.wizard.endDate = event.target.value;
      renderWizardDates();
    });

    function openFeatured(tab) {
      var trip = getFeaturedTrip();
      if (!trip) {
        showAppView("trips");
        return;
      }
      openTrip(trip.id, tab || "overview");
    }

    document.getElementById("dashOpenTrip").addEventListener("click", function () {
      openFeatured("overview");
    });
    document.getElementById("dashOpenMap").addEventListener("click", function () {
      openFeatured("map");
    });

    document.getElementById("tripForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var id = document.getElementById("tripId").value;
      var name = document.getElementById("tripName").value.trim();
      var destination = document.getElementById("tripDestination").value.trim();
      var startDate = document.getElementById("tripStart").value;
      var endDate = document.getElementById("tripEnd").value;
      if (!name || !destination || !startDate || !endDate) {
        alert(t("msg.fillRequired"));
        return;
      }
      if (id) {
        state.trips = state.trips.map(function (trip) {
          if (trip.id === id) {
            var coverType = editCoverState.coverType || "gradient";
            var coverImage = editCoverState.coverImage || "";
            var coverPreset = editCoverState.coverPreset || "sunset";
            if (coverType !== "gradient" && !coverImage) {
              coverType = "gradient";
            }
            return Object.assign({}, trip, {
              name: name,
              destination: destination,
              startDate: startDate,
              endDate: endDate,
              coverType: coverType,
              coverImage: coverImage,
              coverPreset: coverPreset,
              coverPosition: editCoverState.coverPosition || "center"
            });
          }
          return trip;
        });
      }
      persistAll();
      resetTripForm();
      renderTripCards();
      showAppView("trips");
    });

    document.getElementById("tripFormReset").addEventListener("click", resetTripForm);

    document.getElementById("editTripFromOverview").addEventListener("click", function () {
      var trip = getCurrentTrip();
      if (!trip) {
        return;
      }
      showAppView("trips");
      fillTripForm(trip);
      document.getElementById("tripFormPanel").hidden = false;
    });

    document.getElementById("ovAddTodo").addEventListener("click", function () {
      resetTodoForm();
      setTripTab("todo");
      document.getElementById("todoTitle").focus();
    });
    document.getElementById("ovAddNote").addEventListener("click", function () {
      setTripTab("notes");
    });
    document.getElementById("ovAddPlace").addEventListener("click", function () {
      setTripTab("map");
    });
    document.getElementById("ovOpenCalendar").addEventListener("click", function () {
      setTripTab("calendar");
    });

    document.getElementById("todoForm").addEventListener("submit", function (event) {
      event.preventDefault();
      if (!getCurrentTrip()) {
        return;
      }
      var id = document.getElementById("todoId").value;
      var tripDayRaw = document.getElementById("todoTripDay").value;
      var data = alignTodoScheduleFields({
        title: document.getElementById("todoTitle").value.trim(),
        dueDate: document.getElementById("todoDue").value,
        priority: document.getElementById("todoPriority").value,
        category: document.getElementById("todoCategory").value,
        tripDay: tripDayRaw ? Number(tripDayRaw) : "",
        note: document.getElementById("todoNote").value.trim()
      });
      if (!data.title) {
        alert(t("msg.fillRequired"));
        return;
      }
      if (id) {
        updateTodo(id, data);
      } else {
        addTodo(data);
      }
      resetTodoForm();
      refreshTripAgendaViews();
    });
    document.getElementById("todoFormReset").addEventListener("click", resetTodoForm);

    document.getElementById("prevMonth").addEventListener("click", function () {
      state.calendarMonth -= 1;
      if (state.calendarMonth < 0) {
        state.calendarMonth = 11;
        state.calendarYear -= 1;
      }
      renderCalendar();
    });
    document.getElementById("nextMonth").addEventListener("click", function () {
      state.calendarMonth += 1;
      if (state.calendarMonth > 11) {
        state.calendarMonth = 0;
        state.calendarYear += 1;
      }
      renderCalendar();
    });
    document.getElementById("todayMonth").addEventListener("click", function () {
      var now = new Date();
      state.calendarYear = now.getFullYear();
      state.calendarMonth = now.getMonth();
      state.selectedDate = todayStr();
      renderCalendar();
    });
  }

  function init() {
    loadAll();
    state.favorites = loadFavorites();
    TravelI18n.init();
    // Bridge map-route.js to app state (keeps map logic beginner-friendly & separate).
    TravelMapRoute.init({
      getCurrentTrip: getCurrentTrip,
      getPlaces: function () {
        return state.places;
      },
      getItineraryItems: function () {
        return state.itineraryItems;
      },
      setPlaces: function (places) {
        state.places = places;
        TravelStorage.setPlaces(state.places);
      },
      setItineraryItems: function (items) {
        state.itineraryItems = items;
        TravelStorage.setItineraryItems(state.itineraryItems);
      },
      getTodosForDate: function (dateStr) {
        return getTodosForDate(state.currentTripId, dateStr);
      },
      openTodoTab: function (todoId) {
        setTripTab("todo");
        if (todoId) {
          var todo = state.todos.find(function (row) {
            return row.id === todoId;
          });
          if (todo) {
            fillTodoForm(todo);
          }
        }
      },
      onAgendaChanged: function () {
        // Map changed a stop → refresh Guide / Calendar / Overview too.
        renderGuide();
        renderCalendar();
        renderOverview();
        if (typeof TravelMapRoute !== "undefined" && TravelMapRoute.renderDayExtras) {
          TravelMapRoute.renderDayExtras();
        }
      },
      t: t,
      uid: uid,
      formatDate: formatDate,
      parseDate: parseDate,
      getLanguage: function () {
        return TravelI18n.getLanguage();
      }
    });
    bindEvents();
    bindAiEvents();
    refreshAiStatus();
    showAppView("home");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
