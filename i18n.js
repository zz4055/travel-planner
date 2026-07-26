/* 负责语言切换：把语言文件里的文字填到页面上 */

var TravelI18n = (function () {
  var currentLang = "zh";

  function t(key) {
    var pack = window.TRAVEL_I18N && window.TRAVEL_I18N[currentLang];
    if (pack && pack[key]) {
      return pack[key];
    }
    var fallback = window.TRAVEL_I18N && window.TRAVEL_I18N.zh;
    if (fallback && fallback[key]) {
      return fallback[key];
    }
    return key;
  }

  function apply() {
    document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      el.textContent = t(key);
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      el.setAttribute("placeholder", t(key));
    });

    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-title");
      el.setAttribute("title", t(key));
    });

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === currentLang);
    });

    var titleEl = document.querySelector("title");
    if (titleEl) {
      titleEl.textContent = t("app.title");
    }
  }

  function setLanguage(lang) {
    if (!window.TRAVEL_I18N || !window.TRAVEL_I18N[lang]) {
      lang = "zh";
    }
    currentLang = lang;
    TravelStorage.setLanguage(lang);
    apply();
  }

  function init() {
    currentLang = TravelStorage.getLanguage() || "zh";
    if (!window.TRAVEL_I18N[currentLang]) {
      currentLang = "zh";
    }
    apply();
  }

  function getLanguage() {
    return currentLang;
  }

  return {
    t: t,
    apply: apply,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    init: init
  };
})();
