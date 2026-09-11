const DEFAULT_LIBRARY_URL = "http://localhost:5173/library";

document.getElementById("open-library")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: DEFAULT_LIBRARY_URL });
  window.close();
});

document.getElementById("open-options")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: `${DEFAULT_LIBRARY_URL.replace(/\/library$/, "")}/settings` });
  window.close();
});
