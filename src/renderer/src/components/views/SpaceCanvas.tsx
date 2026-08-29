import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { arcPoints, buildRadialLayout, type SpaceNode } from '@shared/radialLayout';
import type { GraphPayload } from '@shared/types';
import { tokenColor } from '../../lib/theme';
import { useUiStore } from '../../store/uiStore';

/**
 * A 360° view of the whole project: folders branch outward from a single root and dependency
 * arcs are drawn across the resulting tree, with an orbit camera to move around it.
 *
 * This exists alongside the Cytoscape view rather than replacing it. The 2D graph is the one
 * that produces exact layouts and vector exports; this one is for reading shape and scale —
 * where the mass sits, which branches reach across the tree, how far a change can travel.
 *
 * Everything is drawn from one instanced mesh and two line sets, so node count costs memory
 * rather than draw calls.
 */

interface SpaceCanvasProps {
  payload: GraphPayload;
}

/** Radius of a drawn node, before the per-depth taper that keeps outer branches fine. */
const FILE_RADIUS = 2.4;
const FOLDER_RADIUS = 4.2;

interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

function colorOf(node: SpaceNode, selected: boolean, gathered = false): THREE.Color {
  if (selected) return new THREE.Color(tokenColor('brand'));
  if (gathered) return new THREE.Color(tokenColor('risk-med'));
  if (node.kind === 'folder') return new THREE.Color(tokenColor('ink-faint'));
  return new THREE.Color(tokenColor('ink-muted'));
}

export function SpaceCanvas({ payload }: SpaceCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandles | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const nodeMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const orderRef = useRef<SpaceNode[]>([]);

  const themeRevision = useUiStore((state) => state.themeRevision);
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);
  const selectNode = useUiStore((state) => state.selectNode);
  const multiSelectedNodeIds = useUiStore((state) => state.multiSelectedNodeIds);

  const [hovered, setHovered] = useState<SpaceNode | null>(null);

  const layout = useMemo(() => buildRadialLayout(payload.nodes ?? []), [payload.nodes]);

  // Scene setup runs once. Data and theme changes rebuild contents without recreating the
  // WebGL context, which is expensive and limited in number by the browser.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 1, 20000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;

    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1, 1);
    scene.add(key);

    const content = new THREE.Group();
    scene.add(content);
    contentRef.current = content;

    // Picking is deferred to the frame loop rather than run from the pointer event.
    // Pointer events fire far faster than frames, and each pick walks every instance in
    // the mesh, so raycasting per event made simply moving the mouse cost more than
    // drawing the scene. One pick per frame at most, reusing a single raycaster.
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    let pointerInside = false;
    let pointerDirty = false;
    let hoveredIndex = -1;

    const onPointerMove = (event: PointerEvent): void => {
      const bounds = container.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      pointerInside = true;
      pointerDirty = true;
    };
    const onPointerLeave = (): void => {
      pointerInside = false;
      pointerDirty = true;
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      controls.update();

      if (pointerDirty) {
        pointerDirty = false;
        const mesh = nodeMeshRef.current;
        let index = -1;
        if (pointerInside && mesh) {
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObject(mesh, false)[0];
          index = hit?.instanceId ?? -1;
        }
        if (index !== hoveredIndex) {
          hoveredIndex = index;
          setHovered(index >= 0 ? (orderRef.current[index] ?? null) : null);
        }
      }

      // Drawing every frame rather than only on a detected change. On-demand rendering
      // left the view blank until the first drag, because a scene rebuilt between frames
      // had no way to announce itself; a steady loop cannot get into that state.
      renderer.render(scene, camera);
    };
    tick();

    const resize = (): void => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    sceneRef.current = { renderer, scene, camera, controls };

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      contentRef.current = null;
      nodeMeshRef.current = null;
    };
  }, []);

  // Rebuilds the drawn scene. Depends on the theme as well as the data, because colours are
  // baked into instance attributes and geometry rather than read from CSS at paint time.
  useEffect(() => {
    const handles = sceneRef.current;
    const content = contentRef.current;
    if (!handles || !content) return;

    for (const child of [...content.children]) {
      content.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
    }

    const nodes = layout.nodes;
    orderRef.current = nodes;
    nodeMeshRef.current = null;
    if (nodes.length === 0) return;

    // A coarse ball. Every triangle here is also a triangle the picker may test against
    // once per instance, so detail costs interaction latency, not just draw time.
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();
    nodes.forEach((node, index) => {
      dummy.position.set(node.position[0], node.position[1], node.position[2]);
      // Deeper nodes are drawn smaller so the trunk stays readable through the branches.
      const taper = 1 / (1 + node.depth * 0.16);
      const base = node.kind === 'folder' ? FOLDER_RADIUS : FILE_RADIUS;
      dummy.scale.setScalar(base * taper);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(
        index,
        colorOf(node, node.id === selectedNodeId, multiSelectedNodeIds.includes(node.id)),
      );
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Lets the picker reject the whole mesh with one test when the ray misses the tree.
    mesh.computeBoundingSphere();
    content.add(mesh);
    nodeMeshRef.current = mesh;

    const trunkPositions: number[] = [];
    for (const [parentId, childId] of layout.trunk) {
      const from = layout.positionById.get(parentId);
      const to = layout.positionById.get(childId);
      if (!from || !to) continue;
      trunkPositions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }
    const trunkGeometry = new THREE.BufferGeometry();
    trunkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(trunkPositions, 3));
    content.add(
      new THREE.LineSegments(
        trunkGeometry,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(tokenColor('edge')),
          transparent: true,
          opacity: 0.85,
        }),
      ),
    );

    const arcPositions: number[] = [];
    for (const edge of payload.edges ?? []) {
      const from = layout.positionById.get(edge.source);
      const to = layout.positionById.get(edge.target);
      if (!from || !to) continue;
      const points = arcPoints(from, to, 10);
      for (let index = 0; index < points.length - 3; index += 3) {
        arcPositions.push(
          points[index]!,
          points[index + 1]!,
          points[index + 2]!,
          points[index + 3]!,
          points[index + 4]!,
          points[index + 5]!,
        );
      }
    }
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute('position', new THREE.Float32BufferAttribute(arcPositions, 3));
    content.add(
      new THREE.LineSegments(
        arcGeometry,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(tokenColor('brand')),
          transparent: true,
          opacity: 0.28,
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, payload.edges, themeRevision]);

  // Frames the camera whenever the extent changes, so a new project is not opened looking at
  // empty space or from inside the tree.
  useEffect(() => {
    const handles = sceneRef.current;
    if (!handles) return;
    const distance = Math.max(layout.extent * 2.6, 160);
    handles.camera.position.set(distance * 0.6, distance * 0.45, distance * 0.7);
    handles.controls.target.set(0, 0, 0);
    handles.controls.update();
  }, [layout.extent]);

  // Recolours in place. Rebuilding the scene on every selection would drop the arcs and
  // trunk for a change that touches one instance colour.
  useEffect(() => {
    const mesh = nodeMeshRef.current;
    if (!mesh) return;

    const gathered = new Set(multiSelectedNodeIds);
    orderRef.current.forEach((node, index) => {
      mesh.setColorAt(index, colorOf(node, node.id === selectedNodeId, gathered.has(node.id)));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [selectedNodeId, multiSelectedNodeIds]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        onClick={(event) => {
          // Folders are scaffolding, not analysable nodes; selecting one would ask the
          // inspector for a file that does not exist.
          if (!hovered || hovered.kind !== 'file') return;

          const store = useUiStore.getState();
          const additive = event.ctrlKey || event.metaKey;

          if (additive && event.shiftKey) {
            const gathered = store.multiSelectedNodeIds.includes(hovered.id)
              ? store.multiSelectedNodeIds
              : [...store.multiSelectedNodeIds, hovered.id];
            store.openPaths(
              gathered.map((id) => id.slice(id.indexOf(':') + 1).split('#')[0] ?? ''),
            );
            return;
          }

          if (additive) {
            store.toggleMultiSelect(hovered.id);
            return;
          }

          store.clearMultiSelect();
          selectNode(hovered.id);
        }}
      />

      {hovered ? (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[60%] truncate rounded border border-edge bg-surface-1/95 px-2 py-1 text-xs text-ink">
          {hovered.kind === 'folder' ? `${hovered.path || 'project'}/` : hovered.path}
          {hovered.kind === 'folder' ? (
            <span className="text-ink-faint"> · {hovered.leafCount} files</span>
          ) : null}
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-3 top-3 rounded border border-edge bg-surface-1/95 px-2 py-1 text-xs text-ink-muted">
        drag to orbit · scroll to zoom · ctrl-click gathers · ctrl-shift-click opens
      </div>
    </div>
  );
}
