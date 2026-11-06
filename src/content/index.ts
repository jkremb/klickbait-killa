import { loadSettings } from "../shared/settings";
import { FeedUi } from "./feed";
import { WatchUi } from "./watch";

async function start(): Promise<void> {
  const settings = await loadSettings();
  const feed = new FeedUi(settings);
  const watch = new WatchUi();

  const onNavigate = () => {
    feed.onNavigate();
    watch.onNavigate();
  };
  document.addEventListener("yt-navigate-finish", onNavigate);
  onNavigate();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["settings"]) void loadSettings().then((next) => feed.updateSettings(next));
  });
}

void start();
