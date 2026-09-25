<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  book: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3 M20 4v15h-3a4 4 0 0 0-4 2",
  folder: "M3 7V5h6l2 2h10v13H3z M3 10h18",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  sun: "M12 3V1M12 23v-2M3 12H1M23 12h-2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  moon: "M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z",
  close: "M6 6l12 12M6 18 18 6",
  type: "M4 7V4h16v3 M12 4v16 M9 20h6",
  back: "M19 12H5 M11 6l-6 6 6 6",
  forward: "M5 12h14 M13 6l6 6-6 6",
  chevron: "m9 5 7 7-7 7",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  check: "M5 12l5 5L20 7",
};
</script>

<template>
  <svg
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name] || paths.book" />
  </svg>
</template>
