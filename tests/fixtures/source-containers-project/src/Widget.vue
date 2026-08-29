<template><div>{{ widgetValue }}</div></template>
<script lang="ts">
import { shared } from './shared';
export const widgetValue = shared;
</script>
<script src="./external-widget.ts"></script>
<script lang="coffee">export widgetCoffee = true</script>
