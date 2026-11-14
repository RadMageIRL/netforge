// Applies the saved theme before the first paint, so a light-theme user never sees a dark flash.
// A separate file rather than an inline script: the Content-Security-Policy allows no inline code.
try {
  var theme = window.localStorage.getItem('netforge.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
} catch (e) {
  // Storage blocked: keep the default dark theme.
}
