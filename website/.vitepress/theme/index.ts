import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { h } from 'vue';
import Landing from './components/Landing.vue';
import BarChart from './components/figures/BarChart.vue';
import CapabilityMatrix from './components/figures/CapabilityMatrix.vue';
import Diagram from './components/figures/Diagram.vue';
import InstallTabs from './components/InstallTabs.vue';
import PageActions from './components/PageActions.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, { 'doc-before': () => h(PageActions) }),
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('BarChart', BarChart);
    app.component('CapabilityMatrix', CapabilityMatrix);
    app.component('Diagram', Diagram);
    app.component('InstallTabs', InstallTabs);
  },
} satisfies Theme;
