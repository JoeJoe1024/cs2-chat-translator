// Runs before first paint (external file: the page's CSP forbids inline scripts).
// Applies the remembered theme so there is no flash of the wrong theme. The server setting is applied later by the app.
(function () {
  try {
    var t = localStorage.getItem("cs2t-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* storage unavailable: follow the system theme */
  }
})();
