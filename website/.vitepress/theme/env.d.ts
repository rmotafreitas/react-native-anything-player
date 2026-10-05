declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
declare module '*.webp' {
  const url: string;
  export default url;
}
