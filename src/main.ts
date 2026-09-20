import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

createApp(App).mount("#app");

performance.mark("reader:mounted");
window.dispatchEvent(new Event("reader:mounted"));
