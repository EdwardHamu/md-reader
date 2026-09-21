<script setup lang="ts">
// Mounts an already-sanitized cloned block from the live document.
// The clone originates from DOMPurify output, so no re-sanitization
// is needed; ids were stripped by the preview builder.
import { shallowRef, watchEffect } from "vue";

const props = defineProps<{ node: HTMLElement | null }>();
const host = shallowRef<HTMLElement | null>(null);

watchEffect(() => {
  const target = host.value;
  if (!target) return;
  target.replaceChildren();
  if (props.node) target.append(props.node);
});
</script>

<template>
  <div ref="host" class="markdown-body preview-body"></div>
</template>
