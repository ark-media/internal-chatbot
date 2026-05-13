// Runs synchronously in <head> before first paint.
// Each laptop sharing a login keeps its own per-session preference via
// sessionStorage; first visit (no stored value) defaults to dark.
(function () {
  try {
    var stored = sessionStorage.getItem('ark-theme');
    var theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
    document.documentElement.classList.add('theme-' + theme);
  } catch {
    document.documentElement.classList.add('theme-dark');
  }
})();
