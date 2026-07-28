/* =========================================================
   Trip Map Route Planner
   - Google Maps JavaScript API
   - Numbered markers + Directions route for one travel day
   - Itinerary list stays in sync with the map
   - Place search: Google Places first, Nominatim fallback
   ========================================================= */

var TravelMapRoute = (function () {
  var api = null;
  var map = null;
  var markers = [];
  var routeLine = null;
  var directionsService = null;
  var directionsRenderer = null;
  var routeRequestId = 0;
  var legTravelByOrder = {};
  var travelMode = "WALKING";
  var markerByItemId = {};
  var selectedDate = "";
  var selectedItemId = "";
  var editMode = false;
  var hideUnplanned = false;
  var bound = false;
  var pickOnMapMode = false;
  var searchMarker = null;
  var infoWindow = null;
  var placesService = null;
  var lastSearchAt = 0;
  var searchCache = {};
  var searchInFlight = false;
  var DEFAULT_CENTER = { lat: 18.7883, lng: 98.9853 };

  function t(key, vars) {
    return api && api.t ? api.t(key, vars) : key;
  }

  function getTrip() {
    return api.getCurrentTrip();
  }

  function getPlaces() {
    return api.getPlaces();
  }

  function getItems() {
    return api.getItineraryItems();
  }

  function saveItineraryItems(items) {
    api.setItineraryItems(items);
    if (api.onAgendaChanged) {
      api.onAgendaChanged();
    }
  }

  function tripDates(trip) {
    if (!trip || !trip.startDate || !trip.endDate) {
      return [];
    }
    var dates = [];
    var cursor = api.parseDate(trip.startDate);
    var end = api.parseDate(trip.endDate);
    while (cursor && end && cursor <= end) {
      dates.push(api.formatDate(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return dates;
  }

  function weekdayLabel(dateStr) {
    var d = api.parseDate(dateStr);
    if (!d) {
      return "";
    }
    var keys = ["week.sun", "week.mon", "week.tue", "week.wed", "week.thu", "week.fri", "week.sat"];
    return t(keys[d.getDay()]);
  }

  function shortDateLabel(dateStr) {
    var d = api.parseDate(dateStr);
    if (!d) {
      return dateStr;
    }
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (api.getLanguage() === "en") {
      return months[d.getMonth()] + " " + d.getDate();
    }
    return d.getMonth() + 1 + "/" + d.getDate();
  }

  function findPlace(placeId) {
    return getPlaces().find(function (place) {
      return place.id === placeId;
    }) || null;
  }

  function itemsForDate(dateStr) {
    var trip = getTrip();
    if (!trip) {
      return [];
    }
    return getItems()
      .filter(function (item) {
        return item.tripId === trip.id && item.date === dateStr;
      })
      .slice()
      .sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
  }

  function unplannedPlaces() {
    var trip = getTrip();
    if (!trip) {
      return [];
    }
    var plannedIds = {};
    getItems().forEach(function (item) {
      if (item.tripId === trip.id) {
        plannedIds[item.placeId] = true;
      }
    });
    return getPlaces().filter(function (place) {
      return place.tripId === trip.id && !plannedIds[place.id];
    });
  }

  function renumberDay(dateStr) {
    var dayItems = itemsForDate(dateStr);
    var orderMap = {};
    dayItems.forEach(function (item, index) {
      orderMap[item.id] = index + 1;
    });
    var next = getItems().map(function (item) {
      if (orderMap[item.id]) {
        return Object.assign({}, item, { order: orderMap[item.id] });
      }
      return item;
    });
    // Silent write: callers that change days notify once after the full update.
    api.setItineraryItems(next);
  }

  function notifyAgendaChanged() {
    if (api.onAgendaChanged) {
      api.onAgendaChanged();
    }
  }

  function mockTravelFromPrevious(order) {
    if (order <= 1) {
      return { distanceFromPrevious: "", durationFromPrevious: "" };
    }
    var km = (0.4 + order * 0.35).toFixed(1);
    var mins = 4 + order * 3;
    return {
      distanceFromPrevious: km + " km",
      durationFromPrevious: mins + " min"
    };
  }

  function travelFromPrevious(order) {
    if (legTravelByOrder[order]) {
      return legTravelByOrder[order];
    }
    return mockTravelFromPrevious(order);
  }

  function getSelectedTravelMode() {
    var el = document.getElementById("routeTravelMode");
    if (el && el.value) {
      travelMode = el.value;
    }
    return travelMode === "DRIVING" ? "DRIVING" : "WALKING";
  }

  function mapsReady() {
    return !!(window.google && window.google.maps && google.maps.Map);
  }

  function requestMapsLoad() {
    if (!window.TravelMapsLoader) {
      return;
    }
    TravelMapsLoader.load().then(function (result) {
      if (result && result.configured && ensureMap() && getTrip()) {
        render();
      }
    });
  }

  function ensureMap() {
    if (map) {
      return true;
    }
    if (!mapsReady()) {
      requestMapsLoad();
      return false;
    }
    var el = document.getElementById("routeMap");
    if (!el) {
      return false;
    }
    // Clear any "missing key" placeholder before attaching the map.
    el.innerHTML = "";

    map = new google.maps.Map(el, {
      center: DEFAULT_CENTER,
      zoom: 13,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: "greedy"
    });

    infoWindow = new google.maps.InfoWindow();
    if (google.maps.places && google.maps.places.PlacesService) {
      placesService = new google.maps.places.PlacesService(map);
    }

    map.addListener("click", function (event) {
      if (!pickOnMapMode || !event.latLng) {
        return;
      }
      applyCoordinates(event.latLng.lat(), event.latLng.lng(), {
        keepName: true,
        reopenForm: true
      });
      endPickOnMap();
    });

    return true;
  }

  function resizeMap() {
    if (!map || !mapsReady()) {
      return;
    }
    google.maps.event.trigger(map, "resize");
  }

  /*
   * Place search: Google Places Text Search when available,
   * otherwise OpenStreetMap Nominatim (classroom fallback).
   */

  function getAcceptLanguage() {
    return api.getLanguage() === "zh" ? "zh-CN" : "en";
  }

  function buildNominatimUrl(query) {
    return (
      "https://nominatim.openstreetmap.org/search" +
      "?format=json" +
      "&addressdetails=1" +
      "&limit=5" +
      "&q=" +
      encodeURIComponent(query)
    );
  }

  function normalizeSearchHits(rawList) {
    return (rawList || [])
      .map(function (item) {
        return {
          name: item.name || (item.display_name ? item.display_name.split(",")[0].trim() : ""),
          display_name: item.display_name || "",
          type: item.type || item.class || "place",
          lat: Number(item.lat),
          lon: Number(item.lon),
          raw: item
        };
      })
      .filter(function (item) {
        return item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon);
      })
      .slice(0, 5);
  }

  function buildFallbackQuery(query) {
    var trip = getTrip();
    var destination = trip && trip.destination ? trip.destination.trim() : "";
    if (!destination) {
      return api.getLanguage() === "zh" ? query + ", 泰国" : query + ", Thailand";
    }
    // Avoid duplicating destination if the user already typed it.
    if (query.toLowerCase().indexOf(destination.toLowerCase()) >= 0) {
      return query;
    }
    return query + ", " + destination;
  }

  // Low-level request to Nominatim. Only call from searchPlaces().
  function requestNominatim(query) {
    return fetch(buildNominatimUrl(query), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": getAcceptLanguage()
      }
    }).then(function (res) {
      if (res.status === 429) {
        var rateErr = new Error("rate_limit");
        rateErr.code = "rate_limit";
        throw rateErr;
      }
      if (!res.ok) {
        var netErr = new Error("network");
        netErr.code = "network";
        throw netErr;
      }
      return res.json();
    });
  }

  function normalizeGooglePlaceHits(results) {
    return (results || [])
      .map(function (item) {
        var loc = item.geometry && item.geometry.location;
        if (!loc) {
          return null;
        }
        var lat = typeof loc.lat === "function" ? loc.lat() : Number(loc.lat);
        var lng = typeof loc.lng === "function" ? loc.lng() : Number(loc.lng);
        return {
          name: item.name || "",
          display_name: item.formatted_address || item.vicinity || item.name || "",
          type: (item.types && item.types[0]) || "place",
          lat: lat,
          lon: lng,
          raw: item
        };
      })
      .filter(function (item) {
        return item && item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon);
      })
      .slice(0, 5);
  }

  function requestGooglePlaces(query) {
    return new Promise(function (resolve, reject) {
      if (!ensureMap() || !placesService) {
        reject({ code: "no_google_places" });
        return;
      }
      var trip = getTrip();
      var request = {
        query: buildFallbackQuery(query),
        language: getAcceptLanguage()
      };
      if (trip && map) {
        request.location = map.getCenter();
        request.radius = 30000;
      }
      placesService.textSearch(request, function (results, status) {
        if (status === google.maps.places.PlacesServiceStatus.OK) {
          resolve(normalizeGooglePlaceHits(results));
          return;
        }
        if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
          resolve([]);
          return;
        }
        reject({ code: "google_places", status: status });
      });
    });
  }

  function searchWithNominatim(cleaned, finish) {
    var waitMs = Math.max(0, 1100 - (Date.now() - lastSearchAt));
    setTimeout(function () {
      requestNominatim(cleaned)
        .then(function (data) {
          var hits = normalizeSearchHits(data);
          if (hits.length) {
            finish(null, hits);
            return null;
          }
          var fallback = buildFallbackQuery(cleaned);
          if (fallback === cleaned) {
            finish(null, []);
            return null;
          }
          return new Promise(function (resolve) {
            setTimeout(resolve, 1100);
          }).then(function () {
            return requestNominatim(fallback);
          });
        })
        .then(function (data) {
          if (data == null) {
            return;
          }
          finish(null, normalizeSearchHits(data));
        })
        .catch(function (err) {
          finish(err || { code: "network" }, []);
        });
    }, waitMs);
  }

  /**
   * searchPlaces(query, onDone)
   * 1) validate input
   * 2) memory cache
   * 3) Google Places when available
   * 4) Nominatim fallback
   */
  function searchPlaces(query, onDone) {
    var cleaned = (query || "").trim();
    if (!cleaned) {
      onDone({ code: "empty" }, []);
      return;
    }

    var cacheKey = getAcceptLanguage() + "::" + cleaned.toLowerCase();
    if (searchCache[cacheKey]) {
      onDone(null, searchCache[cacheKey].slice());
      return;
    }

    if (searchInFlight) {
      onDone({ code: "busy" }, []);
      return;
    }

    searchInFlight = true;

    function finish(err, hits) {
      searchInFlight = false;
      lastSearchAt = Date.now();
      if (!err && hits && hits.length) {
        searchCache[cacheKey] = hits.slice();
      }
      onDone(err, hits || []);
    }

    if (mapsReady()) {
      ensureMap();
      if (placesService) {
        requestGooglePlaces(cleaned)
          .then(function (hits) {
            if (hits && hits.length) {
              finish(null, hits);
              return;
            }
            searchWithNominatim(cleaned, finish);
          })
          .catch(function () {
            searchWithNominatim(cleaned, finish);
          });
        return;
      }
    }

    searchWithNominatim(cleaned, finish);
  }

  function setSearchStatus(containerId, message) {
    var box = document.getElementById(containerId);
    if (!box) {
      return;
    }
    box.hidden = false;
    box.innerHTML = "<p class='hint route-search-status'></p>";
    box.querySelector(".route-search-status").textContent = message;
  }

  function showSearchResults(containerId, results, onPick) {
    var box = document.getElementById(containerId);
    if (!box) {
      return;
    }
    box.innerHTML = "";
    if (!results.length) {
      setSearchStatus(containerId, t("map.searchEmpty"));
      return;
    }

    // Keep finger scroll on the results list (do not hand it to the map).
    box.onwheel = function (event) {
      event.stopPropagation();
    };
    box.ontouchmove = function (event) {
      event.stopPropagation();
    };

    results.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "route-search-item";
      btn.innerHTML =
        "<strong class='route-search-name'></strong>" +
        "<span class='route-search-address'></span>" +
        "<span class='route-search-meta'></span>";
      btn.querySelector(".route-search-name").textContent = item.name;
      btn.querySelector(".route-search-address").textContent = item.display_name;
      btn.querySelector(".route-search-meta").textContent =
        item.type + " · " + item.lat.toFixed(5) + ", " + item.lon.toFixed(5);
      btn.addEventListener("click", function () {
        onPick(item);
        box.hidden = true;
      });
      box.appendChild(btn);
    });
    box.hidden = false;
  }

  function handleSearchError(containerId, err) {
    if (!err) {
      setSearchStatus(containerId, t("map.searchError"));
      return;
    }
    if (err.code === "empty") {
      setSearchStatus(containerId, t("map.searchEmptyInput"));
      return;
    }
    if (err.code === "rate_limit" || err.code === "busy") {
      setSearchStatus(containerId, t("map.searchRateLimit"));
      return;
    }
    setSearchStatus(containerId, t("map.searchError"));
  }

  function applySearchHit(hit, options) {
    options = options || {};
    var lat = Number(hit.lat);
    var lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      alert(t("map.invalidCoords"));
      return;
    }

    var shortName = hit.name || "";
    var nameInput = document.getElementById("routeFormName");
    var addressInput = document.getElementById("routeFormAddress");

    if (nameInput && (options.fillName || !nameInput.value.trim())) {
      nameInput.value = shortName;
    }
    if (addressInput) {
      addressInput.value = hit.display_name || "";
    }

    applyCoordinates(lat, lng, {
      keepName: true,
      reopenForm: !!options.reopenForm,
      popupTitle: shortName
    });
  }

  function applyCoordinates(lat, lng, options) {
    options = options || {};
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      alert(t("map.invalidCoords"));
      return;
    }

    document.getElementById("routeFormLat").value = Number(lat).toFixed(6);
    document.getElementById("routeFormLng").value = Number(lng).toFixed(6);

    if (!ensureMap()) {
      return;
    }
    if (searchMarker) {
      searchMarker.setMap(null);
      searchMarker = null;
    }

    var position = { lat: Number(lat), lng: Number(lng) };
    searchMarker = new google.maps.Marker({
      position: position,
      map: map,
      title: options.popupTitle || t("map.located"),
      zIndex: 1000
    });

    var title = options.popupTitle || t("map.located");
    if (infoWindow) {
      infoWindow.setContent(title);
      infoWindow.open({ map: map, anchor: searchMarker });
    }
    map.setCenter(position);
    map.setZoom(15);

    // Keep Save enabled (form submit button).
    var saveBtn = document.querySelector("#routePlaceForm button[type='submit']");
    if (saveBtn) {
      saveBtn.disabled = false;
      if (!document.getElementById("routeFormItemId").value) {
        saveBtn.textContent = t("map.savePlace");
      }
    }

    if (options.reopenForm) {
      document.getElementById("routePlaceModal").hidden = false;
      TravelI18n.apply();
    }
  }

  function startPickOnMap() {
    ensureMap();
    pickOnMapMode = true;
    document.getElementById("routePlaceModal").hidden = true;
    document.getElementById("routePickBanner").hidden = false;
    document.getElementById("routePickBanner").textContent = t("map.pickHint");
    var el = document.getElementById("routeMap");
    if (el) {
      el.style.cursor = "crosshair";
    }
  }

  function endPickOnMap() {
    pickOnMapMode = false;
    var banner = document.getElementById("routePickBanner");
    if (banner) {
      banner.hidden = true;
    }
    var el = document.getElementById("routeMap");
    if (el) {
      el.style.cursor = "";
    }
  }

  // Map toolbar search button → Google Places / Nominatim.
  function runMapSearch() {
    var input = document.getElementById("routeMapSearchInput");
    var query = input ? input.value.trim() : "";
    var resultsBox = document.getElementById("routeMapSearchResults");
    if (!query) {
      handleSearchError("routeMapSearchResults", { code: "empty" });
      return;
    }

    setSearchStatus("routeMapSearchResults", t("map.searching"));
    searchPlaces(query, function (err, results) {
      if (err) {
        handleSearchError("routeMapSearchResults", err);
        return;
      }
      if (!results.length) {
        setSearchStatus("routeMapSearchResults", t("map.searchEmpty"));
        return;
      }
      showSearchResults("routeMapSearchResults", results, function (hit) {
        openCreatePlace();
        applySearchHit(hit, { fillName: true, reopenForm: true });
      });
    });
  }

  // Place form search button → same search pipeline.
  function runFormSearch() {
    var input = document.getElementById("routeFormSearch");
    var query = input ? input.value.trim() : "";
    if (!query) {
      query = document.getElementById("routeFormName").value.trim();
    }
    if (!query) {
      handleSearchError("routeFormSearchResults", { code: "empty" });
      return;
    }

    setSearchStatus("routeFormSearchResults", t("map.searching"));
    searchPlaces(query, function (err, results) {
      if (err) {
        handleSearchError("routeFormSearchResults", err);
        return;
      }
      if (!results.length) {
        setSearchStatus("routeFormSearchResults", t("map.searchEmpty"));
        return;
      }
      showSearchResults("routeFormSearchResults", results, function (hit) {
        applySearchHit(hit, {
          fillName: !document.getElementById("routeFormName").value.trim()
        });
      });
    });
  }

  // Map pin emoji by place.category (matches routeFormCategory options).
  var CATEGORY_EMOJI = {
    attraction: "🏞️",
    food: "🍜",
    cafe: "☕",
    shopping: "🛍️",
    hotel: "🏨",
    photoSpot: "📷",
    other: "📍"
  };

  function categoryEmoji(category) {
    return CATEGORY_EMOJI[category] || CATEGORY_EMOJI.other;
  }

  function numberMarkerIcon(order, isActive, isDone, category) {
    var bg = isActive ? "#1a2a26" : isDone ? "#2f6b5c" : "#e4572e";
    var emoji = categoryEmoji(category);
    // White bubble with category emoji + small colored order badge.
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="48" viewBox="0 0 44 48">' +
      '<rect x="2" y="2" width="40" height="36" rx="12" fill="#fff" stroke="' +
      bg +
      '" stroke-width="2"/>' +
      '<text x="22" y="26" text-anchor="middle" font-size="18">' +
      emoji +
      "</text>" +
      '<circle cx="34" cy="10" r="9" fill="' +
      bg +
      '" stroke="#fff" stroke-width="2"/>' +
      '<text x="34" y="14" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="sans-serif">' +
      String(order) +
      "</text>" +
      '<path d="M18 38 L22 46 L26 38 Z" fill="' +
      bg +
      '"/>' +
      "</svg>";
    return {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(44, 48),
      anchor: new google.maps.Point(22, 46)
    };
  }

  // Build {lat,lng} points in visit order (1 → 2 → 3 → …).
  function buildOrderedLatLngs(dayItems) {
    var latLngs = [];
    dayItems.forEach(function (item) {
      var place = findPlace(item.placeId);
      if (!place) {
        return;
      }
      var lat = Number(place.latitude);
      var lng = Number(place.longitude);
      if (!lat && !lng) {
        return;
      }
      latLngs.push({ lat: lat, lng: lng });
    });
    return latLngs;
  }

  /*
   * Prefer Google Directions (walking/driving). Fall back to straight order line.
   */
  function drawOrderPolyline(latLngs) {
    if (!map || latLngs.length < 2 || !mapsReady()) {
      return null;
    }

    return new google.maps.Polyline({
      path: latLngs,
      geodesic: true,
      strokeColor: "#e4572e",
      strokeOpacity: 0.92,
      strokeWeight: 5,
      map: map
    });
  }

  function ensureDirectionsTools() {
    if (!mapsReady()) {
      return false;
    }
    if (!directionsService) {
      directionsService = new google.maps.DirectionsService();
    }
    if (!directionsRenderer) {
      directionsRenderer = new google.maps.DirectionsRenderer({
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: {
          strokeColor: "#e4572e",
          strokeOpacity: 0.92,
          strokeWeight: 5
        }
      });
    }
    return true;
  }

  function clearDirectionsRoute() {
    routeRequestId += 1;
    legTravelByOrder = {};
    if (directionsRenderer) {
      try {
        directionsRenderer.setDirections({ routes: [] });
      } catch (err) {
        // ignore clear errors
      }
      directionsRenderer.setMap(null);
    }
  }

  function rememberLegTravel(result) {
    legTravelByOrder = {};
    if (!result || !result.routes || !result.routes[0] || !result.routes[0].legs) {
      return;
    }
    result.routes[0].legs.forEach(function (leg, index) {
      // legs[0] = stop1→stop2 → store under order 2
      legTravelByOrder[index + 2] = {
        distanceFromPrevious: leg.distance ? leg.distance.text : "",
        durationFromPrevious: leg.duration ? leg.duration.text : "",
        isReal: true
      };
    });
  }

  function drawDirectionsRoute(latLngs, onDone) {
    if (!ensureDirectionsTools() || latLngs.length < 2) {
      onDone(null);
      return;
    }

    var waypoints = latLngs.slice(1, -1).map(function (point) {
      return { location: point, stopover: true };
    });
    // Directions API soft limit: 25 waypoints.
    if (waypoints.length > 25) {
      onDone(null);
      return;
    }

    var reqId = ++routeRequestId;
    var mode = getSelectedTravelMode();
    directionsService.route(
      {
        origin: latLngs[0],
        destination: latLngs[latLngs.length - 1],
        waypoints: waypoints,
        optimizeWaypoints: false,
        travelMode: google.maps.TravelMode[mode] || google.maps.TravelMode.WALKING
      },
      function (result, status) {
        if (reqId !== routeRequestId) {
          return;
        }
        if (status === google.maps.DirectionsStatus.OK && result) {
          directionsRenderer.setMap(map);
          directionsRenderer.setDirections(result);
          rememberLegTravel(result);
          onDone(result);
          return;
        }
        onDone(null, status);
      }
    );
  }

  function clearRouteLayers() {
    markers.forEach(function (marker) {
      marker.setMap(null);
    });
    markers = [];
    markerByItemId = {};
    if (routeLine) {
      routeLine.setMap(null);
      routeLine = null;
    }
    clearDirectionsRoute();
  }

  function updateRouteLineNote(hasLine, kind) {
    var note = document.getElementById("routeLineNote");
    if (!note) {
      return;
    }
    note.hidden = !hasLine;
    if (!hasLine) {
      return;
    }
    if (kind === "loading") {
      note.textContent = t("map.directionsLoading");
    } else if (kind === "directions") {
      note.textContent = t("map.directionsNote");
    } else if (kind === "fallback") {
      note.textContent = t("map.directionsFallbackNote");
    } else {
      note.textContent = t("map.orderLineNote");
    }
  }

  /**
   * renderDailyRoute(date)
   * 1. get itinerary items for the selected date
   * 2. sort them by order
   * 3. find related place coordinates
   * 4. render numbered markers (same numbers as the list)
   * 5. draw the ordered polyline 1 → 2 → 3 → …
   * 6. fit the map bounds
   * 7. keep the itinerary list in sync (caller also runs renderList)
   */
  function renderDailyRoute(date) {
    if (!ensureMap()) {
      return [];
    }

    clearRouteLayers();

    if (!date || date === "__overview__") {
      updateRouteLineNote(false);
      return [];
    }

    // 1–2. Items for this day, already sorted by `order`.
    var dayItems = itemsForDate(date);

    // 3–4. Numbered markers in itinerary order.
    dayItems.forEach(function (item) {
      var place = findPlace(item.placeId);
      if (!place) {
        return;
      }
      var lat = Number(place.latitude);
      var lng = Number(place.longitude);
      if (!lat && !lng) {
        return;
      }
      var latLng = { lat: lat, lng: lng };
      var marker = new google.maps.Marker({
        position: latLng,
        map: map,
        icon: numberMarkerIcon(
          item.order,
          item.id === selectedItemId,
          !!item.completed,
          place.category
        ),
        title: categoryEmoji(place.category) + " " + place.name,
        zIndex: 100 + (item.order || 0)
      });
      marker.addListener("click", function () {
        selectedItemId = item.id;
        renderDailyRoute(selectedDate);
        renderList();
        scrollToItem(item.id);
      });
      markers.push(marker);
      markerByItemId[item.id] = marker;
    });

    // 5. Prefer Google Directions along visit order; fall back to straight line.
    var latLngs = buildOrderedLatLngs(dayItems);
    if (latLngs.length >= 2) {
      updateRouteLineNote(true, "loading");
      drawDirectionsRoute(latLngs, function (result) {
        if (result) {
          if (routeLine) {
            routeLine.setMap(null);
            routeLine = null;
          }
          updateRouteLineNote(true, "directions");
          renderList();
        } else {
          if (directionsRenderer) {
            directionsRenderer.setMap(null);
          }
          routeLine = drawOrderPolyline(latLngs);
          updateRouteLineNote(true, "fallback");
        }
      });
    } else {
      updateRouteLineNote(false);
    }

    // 6. Fit map to the visible route / single stop.
    if (latLngs.length === 1) {
      map.setCenter(latLngs[0]);
      map.setZoom(15);
    } else if (latLngs.length > 1) {
      var bounds = new google.maps.LatLngBounds();
      latLngs.forEach(function (point) {
        bounds.extend(point);
      });
      map.fitBounds(bounds, 48);
    } else {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(13);
    }

    setTimeout(resizeMap, 80);

    return dayItems;
  }

  // Keep old name as an alias so existing call sites stay clear.
  function drawMapForDay() {
    renderDailyRoute(selectedDate);
  }

  function scrollToItem(itemId) {
    var el = document.querySelector('[data-route-item="' + itemId + '"]');
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function focusMarker(itemId) {
    selectedItemId = itemId;
    renderDailyRoute(selectedDate);
    var marker = markerByItemId[itemId];
    if (marker && map) {
      map.panTo(marker.getPosition());
    }
  }

  function renderDateTabs() {
    var tabs = document.getElementById("routeDateTabs");
    var trip = getTrip();
    if (!tabs || !trip) {
      return;
    }
    var dates = tripDates(trip);
    if (!selectedDate || dates.indexOf(selectedDate) < 0) {
      selectedDate = dates[0] || trip.startDate;
    }
    tabs.innerHTML = "";

    var overviewBtn = document.createElement("button");
    overviewBtn.type = "button";
    overviewBtn.className = "route-date-tab" + (selectedDate === "__overview__" ? " is-active" : "");
    overviewBtn.textContent = t("map.overview");
    overviewBtn.addEventListener("click", function () {
      selectedDate = "__overview__";
      selectedItemId = "";
      render();
    });
    tabs.appendChild(overviewBtn);

    dates.forEach(function (dateStr, index) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "route-date-tab" + (selectedDate === dateStr ? " is-active" : "");
      btn.innerHTML =
        "<strong>" +
        shortDateLabel(dateStr) +
        "</strong><span>" +
        weekdayLabel(dateStr) +
        "</span><em>" +
        t("todo.dayN", { n: index + 1 }) +
        "</em>";
      btn.addEventListener("click", function () {
        selectedDate = dateStr;
        selectedItemId = "";
        render();
      });
      tabs.appendChild(btn);
    });
  }

  function renderList() {
    var list = document.getElementById("routeItineraryList");
    var empty = document.getElementById("routeEmpty");
    var title = document.getElementById("routeDayTitle");
    var unplannedWrap = document.getElementById("routeUnplannedWrap");
    if (!list || !empty || !title) {
      return;
    }

    list.innerHTML = "";
    document.body.classList.toggle("route-edit-mode", editMode);

    if (selectedDate === "__overview__") {
      title.textContent = t("map.overviewTitle");
      empty.hidden = true;
      renderOverviewCards(list);
      if (unplannedWrap) {
        unplannedWrap.hidden = hideUnplanned;
      }
      renderUnplanned();
      return;
    }

    title.textContent = shortDateLabel(selectedDate) + " · " + weekdayLabel(selectedDate);
    var dayItems = itemsForDate(selectedDate);
    empty.hidden = dayItems.length > 0;

    dayItems.forEach(function (item, index) {
      var place = findPlace(item.placeId);
      if (!place) {
        return;
      }
      var card = document.createElement("article");
      card.className = "route-stop-card" + (item.id === selectedItemId ? " is-active" : "") + (item.completed ? " is-done" : "");
      card.setAttribute("data-route-item", item.id);

      var thumb = place.image
        ? "<img class='route-stop-thumb' src='" + place.image.replace(/'/g, "") + "' alt=''>"
        : "<div class='route-stop-thumb is-fallback'>" + item.order + "</div>";

      var liveTravel = legTravelByOrder[item.order];
      var distanceText =
        (liveTravel && liveTravel.distanceFromPrevious) || item.distanceFromPrevious || "";
      var durationText =
        (liveTravel && liveTravel.durationFromPrevious) || item.durationFromPrevious || "";
      var travel =
        distanceText || durationText
          ? "<p class='route-stop-travel'>" +
            [distanceText, durationText].filter(Boolean).join(" · ") +
            (liveTravel && liveTravel.isReal ? "" : " · " + t("map.mockTravel")) +
            "</p>"
          : index === 0
            ? ""
            : "<p class='route-stop-travel'>" + t("map.mockTravel") + "</p>";

      card.innerHTML =
        "<div class='route-stop-order' title='" +
        t("place." + (place.category || "other")) +
        "'>" +
        "<span class='route-stop-emoji'>" +
        categoryEmoji(place.category) +
        "</span>" +
        "<span class='route-stop-num'>" +
        item.order +
        "</span>" +
        "</div>" +
        thumb +
        "<div class='route-stop-body'>" +
        "<h4></h4>" +
        "<p class='route-stop-meta'></p>" +
        travel +
        "</div>" +
        "<div class='route-stop-actions'>" +
        "<label class='route-check' title='" +
        t("map.visited") +
        "'><input type='checkbox' class='route-complete'" +
        (item.completed ? " checked" : "") +
        "></label>" +
        "<button type='button' class='btn small route-edit-btn'></button>" +
        (editMode
          ? "<div class='route-reorder'>" +
            "<button type='button' class='btn small route-up' aria-label='up'>↑</button>" +
            "<button type='button' class='btn small route-down' aria-label='down'>↓</button>" +
            "<span class='route-drag-handle' aria-hidden='true'>⋮⋮</span>" +
            "</div>"
          : "") +
        "</div>";

      card.querySelector("h4").textContent = place.name;
      card.querySelector(".route-stop-meta").textContent =
        t("place." + place.category) + (item.plannedTime ? " · " + item.plannedTime : "");
      card.querySelector(".route-edit-btn").textContent = t("btn.edit");

      card.addEventListener("click", function (event) {
        if (event.target.closest("button") || event.target.closest("input") || event.target.closest("label")) {
          return;
        }
        focusMarker(item.id);
        card.classList.add("is-active");
      });

      card.querySelector(".route-complete").addEventListener("change", function (event) {
        updateItem(item.id, { completed: event.target.checked });
        render();
      });

      card.querySelector(".route-edit-btn").addEventListener("click", function () {
        openDetail(item.id);
      });

      if (editMode) {
        var up = card.querySelector(".route-up");
        var down = card.querySelector(".route-down");
        if (up) {
          up.disabled = index === 0;
          up.addEventListener("click", function () {
            moveItem(item.id, -1);
          });
        }
        if (down) {
          down.disabled = index === dayItems.length - 1;
          down.addEventListener("click", function () {
            moveItem(item.id, 1);
          });
        }
      }

      list.appendChild(card);
    });

    if (unplannedWrap) {
      unplannedWrap.hidden = hideUnplanned;
    }
    renderUnplanned();
  }

  function renderOverviewCards(list) {
    var trip = getTrip();
    var dates = tripDates(trip);
    dates.forEach(function (dateStr, index) {
      var count = itemsForDate(dateStr).length;
      var card = document.createElement("button");
      card.type = "button";
      card.className = "route-overview-card";
      card.innerHTML =
        "<strong></strong><span></span><em></em>";
      card.querySelector("strong").textContent = t("todo.dayN", { n: index + 1 });
      card.querySelector("span").textContent = shortDateLabel(dateStr) + " · " + weekdayLabel(dateStr);
      card.querySelector("em").textContent = t("map.stopCount", { n: count });
      card.addEventListener("click", function () {
        selectedDate = dateStr;
        render();
      });
      list.appendChild(card);
    });
  }

  function renderUnplanned() {
    var list = document.getElementById("routeUnplannedList");
    var empty = document.getElementById("routeUnplannedEmpty");
    if (!list || !empty) {
      return;
    }
    var places = unplannedPlaces();
    list.innerHTML = "";
    empty.hidden = places.length > 0;
    places.forEach(function (place) {
      var row = document.createElement("div");
      row.className = "route-unplanned-row";
      row.innerHTML =
        "<div><strong></strong><span></span></div>" +
        "<button type='button' class='btn small add-unplanned'></button>";
      row.querySelector("strong").textContent = place.name;
      row.querySelector("span").textContent = t("place." + place.category);
      row.querySelector(".add-unplanned").textContent = t("map.addToDay");
      row.querySelector(".add-unplanned").disabled = selectedDate === "__overview__";
      row.querySelector(".add-unplanned").addEventListener("click", function () {
        if (selectedDate === "__overview__") {
          return;
        }
        addPlaceToDay(place.id, selectedDate);
      });
      list.appendChild(row);
    });
  }

  function updateItem(itemId, changes) {
    var next = getItems().map(function (item) {
      return item.id === itemId ? Object.assign({}, item, changes) : item;
    });
    saveItineraryItems(next);
  }

  function moveItem(itemId, direction) {
    var dayItems = itemsForDate(selectedDate);
    var index = dayItems.findIndex(function (item) {
      return item.id === itemId;
    });
    var target = index + direction;
    if (index < 0 || target < 0 || target >= dayItems.length) {
      return;
    }
    var swapped = dayItems.slice();
    var temp = swapped[index];
    swapped[index] = swapped[target];
    swapped[target] = temp;

    var orderMap = {};
    swapped.forEach(function (item, i) {
      var mock = mockTravelFromPrevious(i + 1);
      orderMap[item.id] = {
        order: i + 1,
        distanceFromPrevious: mock.distanceFromPrevious,
        durationFromPrevious: mock.durationFromPrevious
      };
    });

    var next = getItems().map(function (item) {
      return orderMap[item.id] ? Object.assign({}, item, orderMap[item.id]) : item;
    });
    saveItineraryItems(next);
    selectedItemId = itemId;
    render();
  }

  function addPlaceToDay(placeId, dateStr) {
    var trip = getTrip();
    if (!trip) {
      return;
    }
    var already = getItems().some(function (item) {
      return item.tripId === trip.id && item.placeId === placeId && item.date === dateStr;
    });
    if (already) {
      alert(t("map.alreadyOnDay"));
      return;
    }
    var order = itemsForDate(dateStr).length + 1;
    var mock = mockTravelFromPrevious(order);
    var item = {
      id: api.uid("itin"),
      tripId: trip.id,
      placeId: placeId,
      date: dateStr,
      plannedTime: order === 1 ? "09:00" : "",
      order: order,
      completed: false,
      distanceFromPrevious: mock.distanceFromPrevious,
      durationFromPrevious: mock.durationFromPrevious,
      note: ""
    };
    saveItineraryItems(getItems().concat([item]));
    selectedItemId = item.id;
    closePickModal();
    render();
  }

  function removeStop(itemId) {
    var item = getItems().find(function (entry) {
      return entry.id === itemId;
    });
    if (!item) {
      return;
    }
    api.setItineraryItems(
      getItems().filter(function (entry) {
        return entry.id !== itemId;
      })
    );
    renumberDay(item.date);
    // Refresh mock distances after renumber.
    var dayItems = itemsForDate(item.date);
    var orderMap = {};
    dayItems.forEach(function (entry, i) {
      var mock = mockTravelFromPrevious(i + 1);
      orderMap[entry.id] = Object.assign({ order: i + 1 }, mock);
    });
    saveItineraryItems(
      getItems().map(function (entry) {
        return orderMap[entry.id] ? Object.assign({}, entry, orderMap[entry.id]) : entry;
      })
    );
    selectedItemId = "";
    closeDetail();
    render();
  }

  function openDetail(itemId) {
    var item = getItems().find(function (entry) {
      return entry.id === itemId;
    });
    var place = item ? findPlace(item.placeId) : null;
    if (!item || !place) {
      return;
    }
    selectedItemId = itemId;
    document.getElementById("routeFormPlaceId").value = place.id;
    document.getElementById("routeFormItemId").value = item.id;
    document.getElementById("routeFormName").value = place.name;
    document.getElementById("routeFormCategory").value = place.category || "attraction";
    document.getElementById("routeFormAddress").value = place.address || "";
    document.getElementById("routeFormLat").value = place.latitude;
    document.getElementById("routeFormLng").value = place.longitude;
    document.getElementById("routeFormDate").value = item.date || selectedDate;
    document.getElementById("routeFormTime").value = item.plannedTime || "";
    document.getElementById("routeFormImage").value = place.image || "";
    document.getElementById("routeFormNote").value = item.note || place.note || "";
    document.getElementById("routeFormVisited").checked = !!item.completed;
    document.getElementById("routeRemoveStopBtn").hidden = false;
    document.getElementById("routeMoveDayBtn").hidden = false;
    document.getElementById("routePlaceModal").hidden = false;
    TravelI18n.apply();
  }

  function openCreatePlace() {
    var trip = getTrip();
    if (!trip) {
      return;
    }
    closePickModal();
    document.getElementById("routeFormPlaceId").value = "";
    document.getElementById("routeFormItemId").value = "";
    document.getElementById("routeFormName").value = "";
    document.getElementById("routeFormCategory").value = "attraction";
    document.getElementById("routeFormAddress").value = "";
    document.getElementById("routeFormLat").value = "18.7883";
    document.getElementById("routeFormLng").value = "98.9853";
    document.getElementById("routeFormDate").value =
      selectedDate === "__overview__" ? trip.startDate : selectedDate;
    document.getElementById("routeFormTime").value = "10:00";
    document.getElementById("routeFormImage").value = "";
    document.getElementById("routeFormNote").value = "";
    document.getElementById("routeFormVisited").checked = false;
    document.getElementById("routeFormSearch").value = "";
    document.getElementById("routeFormSearchResults").hidden = true;
    document.getElementById("routeRemoveStopBtn").hidden = true;
    document.getElementById("routeMoveDayBtn").hidden = true;
    document.getElementById("routePlaceModal").hidden = false;
    TravelI18n.apply();
  }

  function closeDetail() {
    endPickOnMap();
    document.getElementById("routePlaceModal").hidden = true;
    var formResults = document.getElementById("routeFormSearchResults");
    if (formResults) {
      formResults.hidden = true;
    }
  }

  function openPickModal() {
    var list = document.getElementById("routePickList");
    var trip = getTrip();
    if (!list || !trip || selectedDate === "__overview__") {
      return;
    }
    list.innerHTML = "";
    var dayPlaceIds = {};
    itemsForDate(selectedDate).forEach(function (item) {
      dayPlaceIds[item.placeId] = true;
    });
    getPlaces()
      .filter(function (place) {
        return place.tripId === trip.id;
      })
      .forEach(function (place) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "route-pick-row";
        row.disabled = !!dayPlaceIds[place.id];
        row.innerHTML = "<strong></strong><span></span>";
        row.querySelector("strong").textContent = place.name;
        row.querySelector("span").textContent =
          t("place." + place.category) + (dayPlaceIds[place.id] ? " · " + t("map.alreadyOnDay") : "");
        row.addEventListener("click", function () {
          addPlaceToDay(place.id, selectedDate);
        });
        list.appendChild(row);
      });
    document.getElementById("routePickModal").hidden = false;
    TravelI18n.apply();
  }

  function closePickModal() {
    var modal = document.getElementById("routePickModal");
    if (modal) {
      modal.hidden = true;
    }
  }

  function savePlaceForm(event) {
    event.preventDefault();
    var trip = getTrip();
    if (!trip) {
      return;
    }
    var placeId = document.getElementById("routeFormPlaceId").value;
    var itemId = document.getElementById("routeFormItemId").value;
    var placeData = {
      name: document.getElementById("routeFormName").value.trim(),
      category: document.getElementById("routeFormCategory").value,
      address: document.getElementById("routeFormAddress").value.trim(),
      latitude: Number(document.getElementById("routeFormLat").value) || 0,
      longitude: Number(document.getElementById("routeFormLng").value) || 0,
      image: document.getElementById("routeFormImage").value.trim(),
      note: document.getElementById("routeFormNote").value.trim()
    };
    if (!placeData.name) {
      alert(t("msg.fillRequired"));
      return;
    }
    if (!placeData.latitude || !placeData.longitude) {
      alert(t("map.locateHint"));
      return;
    }

    var dateStr = document.getElementById("routeFormDate").value || selectedDate;
    if (dateStr === "__overview__") {
      dateStr = trip.startDate;
    }
    var plannedTime = document.getElementById("routeFormTime").value;
    var visited = document.getElementById("routeFormVisited").checked;

    if (placeId) {
      api.setPlaces(
        getPlaces().map(function (place) {
          return place.id === placeId ? Object.assign({}, place, placeData) : place;
        })
      );
      notifyAgendaChanged();
    } else {
      placeId = api.uid("place");
      api.setPlaces(
        getPlaces().concat([
          Object.assign({ id: placeId, tripId: trip.id }, placeData)
        ])
      );
    }

    if (itemId) {
      var oldItem = getItems().find(function (item) {
        return item.id === itemId;
      });
      var oldDate = oldItem ? oldItem.date : dateStr;
      updateItem(itemId, {
        date: dateStr,
        plannedTime: plannedTime,
        completed: visited,
        note: placeData.note
      });
      if (oldDate !== dateStr) {
        renumberDay(oldDate);
        renumberDay(dateStr);
      }
    } else {
      addPlaceToDay(placeId, dateStr);
      var created = itemsForDate(dateStr).find(function (item) {
        return item.placeId === placeId;
      });
      if (created) {
        updateItem(created.id, { plannedTime: plannedTime, completed: visited, note: placeData.note });
      }
    }

    closeDetail();
    selectedDate = dateStr;
    render();
  }

  function moveToAnotherDay() {
    var itemId = document.getElementById("routeFormItemId").value;
    var trip = getTrip();
    if (!itemId || !trip) {
      return;
    }
    var dates = tripDates(trip);
    var choice = prompt(t("map.moveDayPrompt") + "\n" + dates.join(", "), selectedDate);
    if (!choice || dates.indexOf(choice) < 0) {
      return;
    }
    var oldItem = getItems().find(function (item) {
      return item.id === itemId;
    });
    if (!oldItem) {
      return;
    }
    var oldDate = oldItem.date;
    var newOrder = itemsForDate(choice).filter(function (item) {
      return item.id !== itemId;
    }).length + 1;
    var mock = mockTravelFromPrevious(newOrder);
    updateItem(itemId, {
      date: choice,
      order: newOrder,
      distanceFromPrevious: mock.distanceFromPrevious,
      durationFromPrevious: mock.durationFromPrevious
    });
    renumberDay(oldDate);
    renumberDay(choice);
    selectedDate = choice;
    closeDetail();
    render();
  }

  function setEditMode(on) {
    editMode = !!on;
    document.getElementById("routeEditToggle").hidden = editMode;
    document.getElementById("routeDoneEdit").hidden = !editMode;
    renderList();
  }

  function renderDayExtras() {
    var wrap = document.getElementById("routeDayTodosWrap");
    var list = document.getElementById("routeDayTodoList");
    var empty = document.getElementById("routeDayTodoEmpty");
    if (!wrap || !list || !empty) {
      return;
    }
    if (selectedDate === "__overview__" || !api.getTodosForDate) {
      wrap.hidden = true;
      list.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    var todos = api.getTodosForDate(selectedDate) || [];
    list.innerHTML = "";
    empty.hidden = todos.length > 0;
    todos.forEach(function (todo) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "route-day-todo" + (todo.completed ? " is-done" : "");
      row.innerHTML = "<strong></strong><span></span>";
      row.querySelector("strong").textContent = todo.title;
      row.querySelector("span").textContent = [
        t("todo." + todo.category),
        todo.priority === "high" ? t("priority.high") : "",
        todo.completed ? t("label.completed") : ""
      ]
        .filter(Boolean)
        .join(" · ");
      row.addEventListener("click", function () {
        if (api.openTodoTab) {
          api.openTodoTab(todo.id);
        }
      });
      list.appendChild(row);
    });
  }

  function focusDate(dateStr) {
    var trip = getTrip();
    if (!trip || !dateStr) {
      return;
    }
    var dates = tripDates(trip);
    selectedDate = dates.indexOf(dateStr) >= 0 ? dateStr : trip.startDate;
    selectedItemId = "";
    render();
  }

  function render() {
    if (!getTrip()) {
      return;
    }
    renderDateTabs();
    renderList();
    renderDayExtras();
    if (selectedDate !== "__overview__") {
      // Redraw markers + ordered polyline whenever date / data changes.
      renderDailyRoute(selectedDate);
    } else {
      drawOverviewMap();
    }
  }

  function drawOverviewMap() {
    if (!ensureMap()) {
      return;
    }
    clearRouteLayers();
    updateRouteLineNote(false);
    var trip = getTrip();
    var latLngs = [];
    getPlaces()
      .filter(function (place) {
        return place.tripId === trip.id && place.latitude && place.longitude;
      })
      .forEach(function (place, index) {
        var latLng = {
          lat: Number(place.latitude),
          lng: Number(place.longitude)
        };
        latLngs.push(latLng);
        var marker = new google.maps.Marker({
          position: latLng,
          map: map,
          icon: numberMarkerIcon(index + 1, false, false, place.category),
          title: categoryEmoji(place.category) + " " + place.name
        });
        markers.push(marker);
      });
    if (latLngs.length) {
      var bounds = new google.maps.LatLngBounds();
      latLngs.forEach(function (point) {
        bounds.extend(point);
      });
      map.fitBounds(bounds, 40);
    } else {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(12);
    }
    setTimeout(resizeMap, 80);
  }

  function bindEvents() {
    if (bound) {
      return;
    }
    bound = true;

    document.getElementById("routeEditToggle").addEventListener("click", function () {
      setEditMode(true);
    });
    document.getElementById("routeDoneEdit").addEventListener("click", function () {
      setEditMode(false);
    });
    document.getElementById("routeAddPlaceBtn").addEventListener("click", function () {
      if (selectedDate === "__overview__") {
        var trip = getTrip();
        selectedDate = trip ? trip.startDate : selectedDate;
      }
      openPickModal();
    });
    var openTodoBtn = document.getElementById("routeOpenTodoBtn");
    if (openTodoBtn) {
      openTodoBtn.addEventListener("click", function () {
        if (api.openTodoTab) {
          api.openTodoTab("");
        }
      });
    }
    document.getElementById("routeHideUnplanned").addEventListener("change", function (event) {
      hideUnplanned = event.target.checked;
      renderUnplanned();
      document.getElementById("routeUnplannedWrap").hidden = hideUnplanned;
    });
    var travelModeEl = document.getElementById("routeTravelMode");
    if (travelModeEl) {
      travelModeEl.addEventListener("change", function () {
        getSelectedTravelMode();
        if (selectedDate && selectedDate !== "__overview__") {
          renderDailyRoute(selectedDate);
        }
      });
    }
    document.getElementById("routeModalClose").addEventListener("click", closeDetail);
    document.getElementById("routeModalBackdrop").addEventListener("click", closeDetail);
    document.getElementById("routePlaceForm").addEventListener("submit", savePlaceForm);
    document.getElementById("routeRemoveStopBtn").addEventListener("click", function () {
      var itemId = document.getElementById("routeFormItemId").value;
      if (!itemId) {
        return;
      }
      if (!confirm(t("msg.confirmDelete"))) {
        return;
      }
      removeStop(itemId);
    });
    document.getElementById("routeMoveDayBtn").addEventListener("click", moveToAnotherDay);
    document.getElementById("routePickClose").addEventListener("click", closePickModal);
    document.getElementById("routePickBackdrop").addEventListener("click", closePickModal);
    document.getElementById("routeCreatePlaceBtn").addEventListener("click", openCreatePlace);

    document.getElementById("routeMapSearchBtn").addEventListener("click", runMapSearch);
    document.getElementById("routeMapSearchInput").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runMapSearch();
      }
    });
    document.getElementById("routeFormSearchBtn").addEventListener("click", runFormSearch);
    document.getElementById("routeFormSearch").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runFormSearch();
      }
    });
    document.getElementById("routePickOnMapBtn").addEventListener("click", function () {
      startPickOnMap();
    });
  }

  function init(bridge) {
    api = bridge;
    bindEvents();
    requestMapsLoad();
  }

  function onShow() {
    if (!mapsReady()) {
      requestMapsLoad();
    }
    render();
    setTimeout(resizeMap, 100);
  }

  function onLanguageChange() {
    if (document.getElementById("pane-map") && document.getElementById("pane-map").classList.contains("active")) {
      render();
    }
  }

  return {
    init: init,
    onShow: onShow,
    onLanguageChange: onLanguageChange,
    render: render,
    renderDailyRoute: renderDailyRoute,
    renderDayExtras: renderDayExtras,
    focusDate: focusDate
  };
})();
