/* Runs before Vue/CSS modules; intentionally standalone and CSP-compatible. */
(() => {
  let preference;
  try {
    preference = localStorage.getItem("reader-theme");
  } catch {
    // A blocked preference store must not prevent first paint.
  }
  const dark =
    preference === "dark" ||
    (preference !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  window.performance.mark("reader:bootstrap");
  const timeout = setTimeout(() => {
    const message = document.getElementById("startup-message");
    const retry = document.getElementById("startup-retry");
    if (message) message.textContent = "加载时间较长，请检查后重试。";
    if (retry) retry.hidden = false;
  }, 8000);
  window.addEventListener("reader:mounted", () => clearTimeout(timeout), {
    once: true,
  });
})();
