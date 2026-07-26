/* =========================================================
   Unified LocalStorage for the travel app.

   One key only: travelAppData
   {
     language: "zh" | "en",
     currentTripId: "",
     trips: [],
     todos: [],
     notes: [],
     places: [],
     itineraryItems: [],
     photos: [],
     seeded: true
   }

   loadAppData()  — read once when the page opens
   saveAppData()  — write the whole object after every change
   ========================================================= */

var TravelStorage = (function () {
  var DATA_KEY = "travelAppData";

  // Older versions used many keys — migrate once, then remove them.
  var LEGACY = {
    trips: "travelAppTrips",
    places: "travelAppPlaces",
    todos: "travelAppTodos",
    notes: "travelAppNotes",
    photos: "travelAppPhotos",
    currentTripId: "travelAppCurrentTripId",
    language: "travelAppLanguage",
    seeded: "travelAppSeeded"
  };

  function emptyData() {
    return {
      language: "zh",
      currentTripId: "",
      trips: [],
      todos: [],
      notes: [],
      places: [],
      itineraryItems: [],
      photos: [],
      seeded: false
    };
  }

  function parseJson(raw, fallback) {
    if (!raw) {
      return fallback;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function readLegacy() {
    var data = emptyData();
    data.trips = parseJson(localStorage.getItem(LEGACY.trips), []);
    data.places = parseJson(localStorage.getItem(LEGACY.places), []);
    data.todos = parseJson(localStorage.getItem(LEGACY.todos), []);
    data.notes = parseJson(localStorage.getItem(LEGACY.notes), []);
    data.photos = parseJson(localStorage.getItem(LEGACY.photos), []);
    data.currentTripId = localStorage.getItem(LEGACY.currentTripId) || "";
    data.language = localStorage.getItem(LEGACY.language) || "zh";
    data.seeded = localStorage.getItem(LEGACY.seeded) === "1";
    return data;
  }

  function clearLegacy() {
    Object.keys(LEGACY).forEach(function (key) {
      localStorage.removeItem(LEGACY[key]);
    });
  }

  function loadData() {
    var raw = localStorage.getItem(DATA_KEY);
    if (raw) {
      var data = parseJson(raw, null);
      if (data && typeof data === "object") {
        return Object.assign(emptyData(), data);
      }
    }

    var hasLegacy =
      localStorage.getItem(LEGACY.trips) ||
      localStorage.getItem(LEGACY.todos) ||
      localStorage.getItem(LEGACY.seeded);
    if (hasLegacy) {
      var migrated = readLegacy();
      saveData(migrated);
      clearLegacy();
      return migrated;
    }

    return emptyData();
  }

  function saveData(data) {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  }

  // In-memory copy — all getters/setters update this, then save.
  var cache = loadData();

  function commit() {
    saveData(cache);
  }

  return {
    DATA_KEY: DATA_KEY,

    // Clear names requested by the lesson brief.
    loadAppData: function () {
      cache = loadData();
      return cache;
    },

    saveAppData: function () {
      commit();
      return cache;
    },

    getAll: function () {
      return cache;
    },

    setAll: function (data) {
      cache = Object.assign(emptyData(), data || {});
      commit();
    },

    getTrips: function () {
      return cache.trips || [];
    },
    setTrips: function (trips) {
      cache.trips = trips || [];
      commit();
    },

    getPlaces: function () {
      return cache.places || [];
    },
    setPlaces: function (places) {
      cache.places = places || [];
      commit();
    },

    getItineraryItems: function () {
      return cache.itineraryItems || [];
    },
    setItineraryItems: function (items) {
      // Only replaces itineraryItems — trips / places stay intact.
      cache.itineraryItems = items || [];
      commit();
    },

    getTodos: function () {
      return cache.todos || [];
    },
    setTodos: function (todos) {
      // Only replaces the todos array — trips / notes / photos stay intact.
      cache.todos = todos || [];
      commit();
    },

    getTodosByTripId: function (tripId) {
      return (cache.todos || []).filter(function (todo) {
        return todo.tripId === tripId;
      });
    },

    addTodo: function (todo) {
      cache.todos = cache.todos || [];
      cache.todos.unshift(todo);
      commit();
      return todo;
    },

    updateTodo: function (todoId, changes) {
      cache.todos = (cache.todos || []).map(function (todo) {
        return todo.id === todoId ? Object.assign({}, todo, changes) : todo;
      });
      commit();
    },

    deleteTodo: function (todoId) {
      cache.todos = (cache.todos || []).filter(function (todo) {
        return todo.id !== todoId;
      });
      commit();
    },

    getNotes: function () {
      return cache.notes || [];
    },
    setNotes: function (notes) {
      cache.notes = notes || [];
      commit();
    },

    getPhotos: function () {
      return cache.photos || [];
    },
    setPhotos: function (photos) {
      cache.photos = photos || [];
      commit();
    },

    getCurrentTripId: function () {
      return cache.currentTripId || "";
    },
    setCurrentTripId: function (id) {
      cache.currentTripId = id || "";
      commit();
    },

    getCurrentTrip: function () {
      var id = cache.currentTripId;
      return (cache.trips || []).find(function (trip) {
        return trip.id === id;
      }) || null;
    },

    getLanguage: function () {
      return cache.language || "zh";
    },
    setLanguage: function (lang) {
      cache.language = lang || "zh";
      commit();
    },

    isSeeded: function () {
      return !!cache.seeded;
    },
    markSeeded: function () {
      cache.seeded = true;
      commit();
    }
  };
})();
