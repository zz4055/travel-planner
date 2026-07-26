/**
 * Load Google Maps JavaScript API from /api/maps-config.
 * Exposes: window.TravelMapsLoader.load() -> Promise<{ configured, google }>
 */
window.TravelMapsLoader = (function () {
  var loadPromise = null;
  var lastConfig = null;

  function apiBase() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return "";
    }
    return "http://localhost:3002";
  }

  function showMapMissingKey(message) {
    var el = document.getElementById("routeMap");
    if (!el) {
      return;
    }
    el.innerHTML =
      '<div class="route-map-missing">' +
      "<p><strong>Google Maps 未就绪</strong></p>" +
      "<p>" +
      (message || "请在 .env 填写 GOOGLE_MAPS_API_KEY，并启用 Maps JavaScript API 后重启 npm start。") +
      "</p>" +
      "</div>";
  }

  function injectScript(apiKey) {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.maps) {
        resolve(window.google);
        return;
      }

      var callbackName = "__travelGoogleMapsInit_" + Date.now();
      var timeoutId = setTimeout(function () {
        cleanup();
        reject(new Error("Google Maps 加载超时"));
      }, 20000);

      function cleanup() {
        clearTimeout(timeoutId);
        try {
          delete window[callbackName];
        } catch (e) {
          window[callbackName] = undefined;
        }
      }

      window[callbackName] = function () {
        cleanup();
        if (window.google && window.google.maps) {
          resolve(window.google);
        } else {
          reject(new Error("Google Maps 回调失败"));
        }
      };

      var script = document.createElement("script");
      script.async = true;
      script.defer = true;
      script.src =
        "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(apiKey) +
        "&libraries=places&callback=" +
        callbackName;
      script.onerror = function () {
        cleanup();
        reject(new Error("Google Maps 脚本加载失败"));
      };
      document.head.appendChild(script);
    });
  }

  function load() {
    if (loadPromise) {
      return loadPromise;
    }

    loadPromise = fetch(apiBase() + "/api/maps-config")
      .then(function (res) {
        if (!res.ok) {
          throw new Error("无法读取地图配置");
        }
        return res.json();
      })
      .then(function (config) {
        lastConfig = config || {};
        if (!lastConfig.configured || !lastConfig.googleMapsApiKey) {
          showMapMissingKey();
          return { configured: false, google: null, config: lastConfig };
        }
        return injectScript(lastConfig.googleMapsApiKey).then(function (google) {
          return { configured: true, google: google, config: lastConfig };
        });
      })
      .catch(function (err) {
        showMapMissingKey(
          (err && err.message ? err.message + "。" : "") +
            "请用 npm start 打开 http://localhost:3002 ，并检查 GOOGLE_MAPS_API_KEY。"
        );
        return { configured: false, google: null, error: err };
      });

    return loadPromise;
  }

  function getConfig() {
    return lastConfig;
  }

  return {
    load: load,
    getConfig: getConfig,
    showMapMissingKey: showMapMissingKey
  };
})();
