/**
 * cytoscape-fcose ships no type declarations. Its only use here is registration via
 * `cytoscape.use`, and layout options are passed through Cytoscape's own `LayoutOptions`,
 * so a minimal declaration is enough.
 */
declare module 'cytoscape-fcose' {
  import type cytoscape from 'cytoscape';

  const extension: cytoscape.Ext;
  export default extension;
}
