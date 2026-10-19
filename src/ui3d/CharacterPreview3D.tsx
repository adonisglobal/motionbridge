import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Motion3DFrame, Skeleton3D } from '../motion3d/types.ts';
import { retargetFrame3D } from '../motion3d/retarget.ts';
import {
  BONE_LABELS_3D, applyPose3D, autoMapBones3D, captureRest3D, createBuiltinCharacter3D,
  disposeObject3D, loadCharacter3D, resetCharacter3D, validateMapping3D,
} from '../character3d/rig.ts';
import type { BoneMapping3D, CharacterRig3D } from '../character3d/rig.ts';
import { exportAnimatedGLB3D } from '../character3d/export.ts';
import './character3d.css';

export interface CharacterPreview3DProps {
  frame?: Motion3DFrame | null;
  reference?: Motion3DFrame | null;
  strength: number;
  inPlace: boolean;
  active?: boolean;
  captureBusy?: boolean;
  onSkeletonChange?: (skeleton: Skeleton3D, name: string) => void;
  frames?: readonly Motion3DFrame[];
  analysisFps?: number;
  exportName?: string;
  allowUncertain?: boolean;
  calibration?: 'anatomical' | 'reference';
}

interface Stage3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  helper?: THREE.SkeletonHelper;
  rig: CharacterRig3D;
  home: () => void;
  render: () => void;
}

export function CharacterPreview3D(props: CharacterPreview3DProps) {
  const { frame, reference, active = true, onSkeletonChange } = props;
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stage = useRef<Stage3D | undefined>(undefined);
  const current = useRef(props);
  const operation = useRef(0);
  const [rig, setRig] = useState<CharacterRig3D>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restMode, setRestMode] = useState(false);
  const [showBones, setShowBones] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [facing, setFacing] = useState(0);
  const [exporting, setExporting] = useState(false);
  current.current = props;
  const display = useRef({ restMode, showBones, showMesh });
  display.current = { restMode, showBones, showMesh };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' }); }
    catch { setError('WebGL could not start. Enable hardware acceleration or try a browser with WebGL support.'); return; }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#12191c');
    scene.fog = new THREE.Fog('#12191c', 7, 18);
    const camera = new THREE.PerspectiveCamera(36, 1, .01, 100);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D character preview. Drag to orbit, scroll to zoom, and right-drag to pan.');
    renderer.domElement.setAttribute('role', 'img');
    element.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .12;
    controls.minDistance = .6; controls.maxDistance = 20;
    controls.maxPolarAngle = Math.PI * .96;
    scene.add(new THREE.HemisphereLight('#dcf6ee', '#344251', 2.2));
    const key = new THREE.DirectionalLight('#e0ffe8', 3.1);
    key.position.set(3, 5, 4); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.normalBias = .03;
    key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
    scene.add(key);
    const rim = new THREE.DirectionalLight('#a8b7ff', 2.3); rim.position.set(-3, 2, -2); scene.add(rim);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#171f22', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.008; ground.receiveShadow = true; scene.add(ground);
    const grid = new THREE.GridHelper(12, 24, '#536c67', '#293b3a'); grid.position.y = .001; scene.add(grid);
    const builtin = createBuiltinCharacter3D(); scene.add(builtin.root);
    const helper = new THREE.SkeletonHelper(builtin.root); helper.visible = false; scene.add(helper);
    const home = () => { camera.position.set(2.5, 1.8, 4.3); controls.target.set(0, .98, 0); controls.update(); };
    const value: Stage3D = { renderer, scene, camera, controls, rig: builtin, helper, home, render: () => {} };
    stage.current = value; home(); setRig(builtin);
    const resize = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const render = () => {
      const source = current.current;
      if (source.active === false) return;
      const settings = display.current;
      if (settings.restMode || !source.frame || !source.reference) resetCharacter3D(value.rig);
      else {
        try { applyPose3D(value.rig, retargetFrame3D(source.frame, source.reference, value.rig.skeleton, { strength: source.strength, inPlace: source.inPlace, calibration: source.calibration })); }
        catch { resetCharacter3D(value.rig); }
      }
      value.rig.root.visible = settings.restMode || (!source.reference && !source.frame) || !!source.frame?.valid;
      value.rig.root.traverse(object => { if ((object as THREE.Mesh).isMesh) object.visible = settings.showMesh; });
      if (value.helper) { value.helper.visible = settings.showBones && value.rig.root.visible; value.helper.updateMatrixWorld(true); }
      controls.update(); renderer.render(scene, camera);
    };
    // The loop runs only while this tab is visible. The scene and imported rig survive tab changes.
    value.render = render;
    if (current.current.active !== false) renderer.setAnimationLoop(render);
    const contextLost = (event: Event) => { event.preventDefault(); setError('The 3D graphics context was lost. Reload the page to restore the preview.'); };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    return () => {
      operation.current++;
      observer.disconnect(); renderer.setAnimationLoop(null); controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      if (value.helper) { value.helper.geometry.dispose(); (value.helper.material as THREE.Material).dispose(); scene.remove(value.helper); }
      disposeObject3D(value.rig.root); disposeObject3D(scene);
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      if (stage.current === value) stage.current = undefined;
    };
  }, []);

  useEffect(() => {
    const value = stage.current;
    if (value) value.renderer.setAnimationLoop(active ? value.render : null);
  }, [active]);

  useEffect(() => {
    if (rig) onSkeletonChange?.(rig.skeleton, rig.name);
  }, [rig, revision, onSkeletonChange]);

  function replaceRig(next: CharacterRig3D) {
    const value = stage.current;
    if (!value) { disposeObject3D(next.root); return; }
    if (value.helper) { value.helper.geometry.dispose(); (value.helper.material as THREE.Material).dispose(); value.scene.remove(value.helper); }
    disposeObject3D(value.rig.root);
    value.rig = next; value.scene.add(next.root);
    value.helper = new THREE.SkeletonHelper(next.root); value.scene.add(value.helper);
    value.home(); setRig(next); setFacing(0); setRestMode(false); setError(''); setRevision(number => number + 1);
  }

  async function importModel(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const token = ++operation.current; setLoading(true); setError('');
    try {
      const next = await loadCharacter3D(file);
      if (token !== operation.current || !stage.current) { disposeObject3D(next.root); return; }
      replaceRig(next); setMappingOpen(true);
    } catch (cause) {
      if (token === operation.current) setError(cause instanceof Error ? cause.message : 'Could not read the 3D model.');
    } finally { if (token === operation.current) setLoading(false); }
  }

  function updateMapping(mapping: BoneMapping3D) {
    if (!rig) return;
    const issues = validateMapping3D(rig, mapping);
    if (issues.length) { setError(issues.join(' ')); return; }
    resetCharacter3D(rig); rig.mapping = mapping; captureRest3D(rig); setError(''); setRevision(number => number + 1);
  }

  function changeFacing(degrees: number) {
    if (!rig) return;
    resetCharacter3D(rig);
    for (const child of rig.root.children) if (!(child as THREE.Bone).isBone && !(child as THREE.Mesh).isMesh) child.rotation.y += (degrees - facing) * Math.PI / 180;
    // The built-in skeleton and mesh share model space and already face +Z.
    if (!rig.imported) return;
    captureRest3D(rig); setFacing(degrees); setRevision(number => number + 1);
  }

  async function exportModel() {
    if (!rig || !reference || !props.frames?.length || props.captureBusy) return;
    setExporting(true); setError('');
    const token = operation.current;
    try {
      const data = await exportAnimatedGLB3D(rig, { frames: props.frames, reference, fps: props.analysisFps ?? 24,
        strength: props.strength, inPlace: props.inPlace, calibration: props.calibration, allowUncertain: props.allowUncertain, name: props.exportName || 'Captured motion' });
      if (token !== operation.current || !stage.current) return;
      const url = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `${(props.exportName || 'captured-motion').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}.animated.glb`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (token === operation.current) setError(cause instanceof Error ? cause.message : 'Could not export the animated character.'); }
    finally { if (token === operation.current) setExporting(false); }
  }

  const mappedCount = rig ? Object.values(rig.mapping).filter(Boolean).length : 0;
  const missing = rig ? HUMANOID_BONES.filter(name => !rig.mapping[name]) : [];
  const invalid = frame && !frame.valid;
  return <section className="panel rig3d-panel" aria-labelledby="rig3d-title">
    <div className="preview-header">
      <div className="panel-title"><i>02</i><span id="rig3d-title">3D character</span><span className="rig3d-label">{rig?.name ?? 'Starting WebGL'}</span></div>
      <div className="view-switch" role="group" aria-label="Character preview mode">
        <button className={!restMode ? 'selected' : ''} aria-pressed={!restMode} onClick={() => setRestMode(false)}>Motion</button>
        <button className={restMode ? 'selected' : ''} aria-pressed={restMode} onClick={() => setRestMode(true)}>Bind pose</button>
      </div>
    </div>
    <div className="rig3d-stage" ref={host}>
      <div className="rig3d-axis" aria-hidden="true"><span>X</span><span>Y ↑</span><span>Z</span></div>
      <div className="rig3d-stage-note">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
      {(invalid || (!frame && reference)) && !restMode && <div className="rig3d-status" role="status">No tracked 3D motion at this time</div>}
      {!frame && !reference && !restMode && <div className="rig3d-waiting">Your model is ready. Analyze a video to animate it.</div>}
      {frame?.valid && frame.needsReview && !restMode && <div className="rig3d-waiting rig3d-review">Some body parts need review</div>}
    </div>
    <div className="rig3d-tools">
      <input ref={input} className="sr-only" type="file" accept=".glb,.fbx" aria-label="Import 3D character" onChange={importModel} />
      <button className="rig3d-primary" disabled={loading || exporting} onClick={() => input.current?.click()}>{loading ? 'Loading model…' : 'Import GLB / FBX'}</button>
      <button disabled={loading || exporting || !rig?.imported} onClick={() => { ++operation.current; replaceRig(createBuiltinCharacter3D()); }}>Studio humanoid</button>
      <button onClick={() => stage.current?.home()}>Reset camera</button>
      <button disabled={loading || exporting || props.captureBusy || !reference || !props.frames?.length} onClick={exportModel}>{exporting ? 'Baking animation…' : 'Download animated GLB'}</button>
      <label><input type="checkbox" checked={showMesh} onChange={event => setShowMesh(event.target.checked)} /> Mesh</label>
      <label><input type="checkbox" checked={showBones} onChange={event => setShowBones(event.target.checked)} /> Skeleton</label>
    </div>
    <div className="rig3d-info" role="status">
      <span>{rig ? `${mappedCount} / ${HUMANOID_BONES.length} body bones mapped` : 'Initializing the 3D scene'}</span>
      <span>{restMode ? 'Model bind pose' : reference ? 'Calibrated motion' : 'Waiting for motion reference'}</span>
    </div>
    {!!props.frames?.length && <div className="rig3d-export-range">GLB export range: {(props.frames[0].timestampMs / 1000).toFixed(2)}–{(props.frames[props.frames.length - 1].timestampMs / 1000).toFixed(2)} s · {props.analysisFps ?? 24} FPS</div>}
    <div className="rig3d-import-note">Animated GLB includes the model, skeleton, and baked motion for direct import into Blender. Models stay on your device.{rig?.imported ? ' Match the model’s facing direction and check the bone mapping before exporting.' : ''}</div>
    {error && <div className="rig3d-error" role="alert">{error}<button aria-label="Dismiss model error" onClick={() => setError('')}>×</button></div>}
    {rig?.imported && <div className="rig3d-mapping">
      <button className="rig3d-disclosure" aria-expanded={mappingOpen} onClick={() => setMappingOpen(value => !value)}>Bone mapping and calibration <span>{mappingOpen ? '−' : '+'}</span></button>
      {mappingOpen && <div className="rig3d-mapping-body">
        <div className="rig3d-calibration"><label>Original model forward <select value={facing} onChange={event => changeFacing(Number(event.target.value))}><option value={0}>Forward +Z</option><option value={180}>Forward −Z</option><option value={-90}>Forward +X</option><option value={90}>Forward −X</option></select></label><button onClick={() => updateMapping(autoMapBones3D(rig.bones))}>Auto-map bones</button></div>
        <p>Bind transforms are preserved. {props.calibration === 'anatomical' ? 'Captured body directions are aligned to the model’s anatomy and facing.' : 'Choose a source reference frame that matches the model’s rest stance.'} Unmapped body parts keep their bind pose.</p>
        {missing.length > 0 && <p className="rig3d-warning">Unmapped: {missing.map(name => BONE_LABELS_3D[name]).join(', ')}.</p>}
        <div className="rig3d-map-grid">{HUMANOID_BONES.map(name => <label key={name}>{BONE_LABELS_3D[name]}<select aria-label={`Map ${BONE_LABELS_3D[name]}`} value={rig.mapping[name] ?? ''} onChange={event => { const next = { ...rig.mapping }; if (event.target.value) next[name] = event.target.value; else delete next[name]; updateMapping(next); }}><option value="">Not assigned</option>{rig.bones.map((bone, index) => <option key={bone.uuid} value={bone.uuid} disabled={Object.entries(rig.mapping).some(([other, id]) => other !== name && id === bone.uuid)}>{bone.name || `Bone ${index + 1}`}</option>)}</select></label>)}</div>
      </div>}
    </div>}
  </section>;
}
