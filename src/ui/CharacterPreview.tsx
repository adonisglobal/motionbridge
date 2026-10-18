import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent } from 'react';
import { BONE_JOINTS, BONE_NAMES, JOINT_NAMES } from '../motion/canonical.ts';
import type { BoneName, CanonicalFrame, JointName, Vec2 } from '../motion/canonical.ts';
import { retargetPose } from '../motion/retarget.ts';
import {
  BONE_LABELS, JOINT_LABELS, createBuiltinRig, createSingleImageRig, guessBone,
  importedPart, loadPng, replacePart, withPartAnchors,
} from '../character/rig.ts';
import type { CharacterPart, CharacterRig } from '../character/rig.ts';
import { characterViewport, drawCharacter } from '../character/renderer.ts';

export interface CharacterPreviewProps {
  motion: CanonicalFrame | undefined;
  reference: CanonicalFrame | undefined;
  onError?: (message: string) => void;
}

const STAGE_WIDTH = 640;
const STAGE_HEIGHT = 600;

export function CharacterPreview({ motion, reference }: CharacterPreviewProps) {
  const [rig, setRig] = useState<CharacterRig>();
  const [sourceImage, setSourceImage] = useState<HTMLImageElement>();
  const [mode, setMode] = useState<'motion' | 'rig'>('motion');
  const [strength, setStrength] = useState(1);
  const [inPlace, setInPlace] = useState(false);
  const [showBones, setShowBones] = useState(false);
  const [activeJoint, setActiveJoint] = useState<JointName>('neck');
  const [selectedBone, setSelectedBone] = useState<BoneName>('torso');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cutDirty, setCutDirty] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const singleInput = useRef<HTMLInputElement>(null);
  const partsInput = useRef<HTMLInputElement>(null);
  const dragJoint = useRef<JointName | null>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const selectedPart = rig?.parts.find(part => part.bone === selectedBone);

  useEffect(() => {
    mounted.current = true;
    const token = ++operation.current;
    createBuiltinRig().then(value => {
      if (mounted.current && operation.current === token) { setRig(value); setLoading(false); }
    }).catch(cause => {
      if (mounted.current && operation.current === token) {
        setError(cause instanceof Error ? cause.message : 'Could not create the character.'); setLoading(false);
      }
    });
    return () => { mounted.current = false; operation.current++; };
  }, []);

  const result = useMemo(() => {
    if (!rig || !motion || !reference) return { pose: undefined, error: '' };
    try { return { pose: retargetPose(motion, reference, rig, { strength, inPlace }), error: '' }; }
    catch (cause) { return { pose: undefined, error: cause instanceof Error ? cause.message : 'Could not apply the motion.' }; }
  }, [rig, motion, reference, strength, inPlace]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!rig || !ctx) return;
    if (mode === 'motion' && reference && (!motion || !result.pose || result.error)) {
      ctx.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
      return;
    }
    drawCharacter(ctx, rig, mode === 'rig' ? undefined : result.pose, {
      width: STAGE_WIDTH, height: STAGE_HEIGHT, showRig: mode === 'rig', activeJoint,
      sourceImage: mode === 'rig' ? sourceImage : undefined,
    });
    if (showBones && mode === 'motion' && result.pose?.valid) {
      const viewport = characterViewport(rig, STAGE_WIDTH, STAGE_HEIGHT);
      ctx.save(); ctx.translate(viewport.x, viewport.y); ctx.scale(viewport.scale, viewport.scale);
      ctx.fillStyle = '#fff9';
      const visibleJoints = new Set<JointName>();
      for (const bone of BONE_NAMES) {
        if (result.pose.confidence[bone] < .35) continue;
        for (const joint of BONE_JOINTS[bone]) visibleJoints.add(joint);
      }
      for (const name of visibleJoints) {
        const point = result.pose.joints[name];
        ctx.beginPath(); ctx.arc(point.x, point.y, 2.5 / viewport.scale, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }, [rig, mode, result.pose, result.error, motion, reference, activeJoint, sourceImage, showBones]);

  async function runImport(action: () => Promise<void>) {
    const token = ++operation.current;
    setLoading(true); setError('');
    try { await action(); }
    catch (cause) {
      if (mounted.current && token === operation.current) {
        const message = cause instanceof Error ? cause.message : 'Could not load the character.';
        setError(message);
      }
    } finally { if (mounted.current && token === operation.current) setLoading(false); }
  }

  function chooseSingle(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void runImport(async () => {
      const token = operation.current;
      const image = await loadPng(file);
      const nextRig = await createSingleImageRig(image);
      if (!mounted.current || token !== operation.current) return;
      nextRig.name = file.name;
      setRig(nextRig); setSourceImage(image); setMode('rig'); setCutDirty(false);
    });
  }

  function chooseParts(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || !rig) return;
    void runImport(async () => {
      if (files.length > BONE_NAMES.length) throw new Error('Choose up to 14 PNG parts at a time.');
      const token = operation.current;
      let nextRig = rig;
      const used = new Set(files.map(file => guessBone(file.name)).filter((name): name is BoneName => name !== undefined));
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const image = await loadPng(file);
        const bone = guessBone(file.name) ?? BONE_NAMES.find(name => !used.has(name)) ?? BONE_NAMES[index];
        used.add(bone);
        nextRig = replacePart(nextRig, importedPart(image, bone, file.name));
      }
      if (!mounted.current || token !== operation.current) return;
      setRig({ ...nextRig, name: 'PNG parts character' });
      setSourceImage(undefined); setCutDirty(false); setMode('rig');
    });
  }

  function resetCharacter() {
    void runImport(async () => {
      const token = operation.current;
      const nextRig = await createBuiltinRig();
      if (!mounted.current || token !== operation.current) return;
      setRig(nextRig); setSourceImage(undefined); setCutDirty(false); setMode('motion');
    });
  }

  function recut() {
    if (!sourceImage || !rig) return;
    void runImport(async () => {
      const token = operation.current;
      const nextRig = await createSingleImageRig(sourceImage, rig);
      if (!mounted.current || token !== operation.current) return;
      setRig({ ...nextRig, name: rig.name }); setCutDirty(false); setMode('motion');
    });
  }

  function canvasPoint(event: PointerEvent<HTMLCanvasElement>): Vec2 | undefined {
    if (!rig) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewport = characterViewport(rig, STAGE_WIDTH, STAGE_HEIGHT);
    return {
      x: Math.max(0, Math.min(rig.width, ((event.clientX - bounds.left) / bounds.width * STAGE_WIDTH - viewport.x) / viewport.scale)),
      y: Math.max(0, Math.min(rig.height, ((event.clientY - bounds.top) / bounds.height * STAGE_HEIGHT - viewport.y) / viewport.scale)),
    };
  }

  function moveJoint(joint: JointName, point: Vec2) {
    setRig(previous => previous ? { ...previous, joints: { ...previous.joints, [joint]: point } } : previous);
    if (sourceImage) setCutDirty(true);
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (mode !== 'rig' || loading || !rig) return;
    const point = canvasPoint(event);
    if (!point) return;
    const viewport = characterViewport(rig, STAGE_WIDTH, STAGE_HEIGHT);
    const closest = JOINT_NAMES.reduce((nearest, name) =>
      Math.hypot(rig.joints[name].x - point.x, rig.joints[name].y - point.y) <
      Math.hypot(rig.joints[nearest].x - point.x, rig.joints[nearest].y - point.y) ? name : nearest,
    JOINT_NAMES[0]);
    const threshold = 17 / viewport.scale;
    const joint = Math.hypot(rig.joints[closest].x - point.x, rig.joints[closest].y - point.y) <= threshold ? closest : activeJoint;
    setActiveJoint(joint); dragJoint.current = joint;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveJoint(joint, point);
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!dragJoint.current) return;
    const point = canvasPoint(event);
    if (point) moveJoint(dragJoint.current, point);
  }

  function updatePart(nextPart: CharacterPart) {
    setRig(previous => previous ? replacePart(previous, nextPart) : previous);
  }

  function changeBone(part: CharacterPart, bone: BoneName) {
    if (part.bone === bone) return;
    setRig(previous => {
      if (!previous) return previous;
      const destination = previous.parts.find(item => item.bone === bone);
      const next = importedPart(part.image as HTMLImageElement, bone, part.name);
      next.drawOrder = destination?.drawOrder ?? part.drawOrder;
      const parts = previous.parts.filter(item => item.bone !== part.bone && item.bone !== bone);
      if (destination?.source === 'imported') {
        const swapped = importedPart(destination.image as HTMLImageElement, part.bone, destination.name);
        swapped.drawOrder = part.drawOrder;
        parts.push(swapped);
      }
      return { ...previous, parts: [...parts, next] };
    });
    setSelectedBone(bone);
  }

  function shiftLayer(part: CharacterPart, direction: number) {
    if (!rig) return;
    const ordered = [...rig.parts].sort((a, b) => a.drawOrder - b.drawOrder);
    const position = ordered.indexOf(part);
    const target = ordered[position + direction];
    if (!target) return;
    const order = part.drawOrder;
    setRig({ ...rig, parts: rig.parts.map(item => item === part ? { ...item, drawOrder: target.drawOrder } : item === target ? { ...item, drawOrder: order } : item) });
  }

  function anchorControl(anchor: 'pivot' | 'tip', axis: 'x' | 'y', label: string) {
    if (!selectedPart) return null;
    const dimension = axis === 'x' ? selectedPart.width : selectedPart.height;
    const value = selectedPart[anchor][axis] / dimension;
    return <label className="character-field">{label}<span dir="ltr">{Math.round(value * 100)}%</span>
      <input type="range" min="0" max="1" step=".01" value={Math.max(0, Math.min(1, value))} onChange={event => {
        const next = { ...selectedPart[anchor], [axis]: Number(event.target.value) * dimension };
        updatePart(withPartAnchors(selectedPart, anchor === 'pivot' ? next : selectedPart.pivot, anchor === 'tip' ? next : selectedPart.tip));
      }} />
    </label>;
  }

  const waiting = !motion || !reference;
  const status = mode === 'rig' ? 'Editing rest joints' : !motion && reference ? 'No analyzed motion at this time'
    : waiting ? 'Rest pose · waiting for motion'
    : result.pose?.valid ? result.pose.needsReview ? 'Needs review · some parts may be hidden' : 'Applying motion to the character'
      : 'Insufficient body tracking · review the source';

  return <section className="panel character-panel">
    <div className="character-header"><div className="panel-title"><span>02 <i>/</i> Character animation</span><span className="small-tag">PNG CUTOUT</span></div><span className="character-status">{rig?.parts.length ?? 0} parts</span></div>
    <div className="character-toolbar">
      <div className="view-switch" role="group" aria-label="Character mode">
        <button className={mode === 'motion' ? 'selected' : ''} aria-pressed={mode === 'motion'} disabled={loading || cutDirty} onClick={() => setMode('motion')}>Motion preview</button>
        <button className={mode === 'rig' ? 'selected' : ''} aria-pressed={mode === 'rig'} disabled={loading} onClick={() => setMode('rig')}>Edit joints</button>
      </div>
      <button disabled={loading} onClick={() => singleInput.current?.click()}>Single PNG</button>
      <button disabled={loading} onClick={() => partsInput.current?.click()}>Import PNG parts</button>
      <button disabled={loading} onClick={resetCharacter}>Default character</button>
      <input ref={singleInput} type="file" accept=".png,image/png" className="sr-only" aria-label="Import a character from a single PNG image" onChange={chooseSingle} />
      <input ref={partsInput} type="file" accept=".png,image/png" multiple className="sr-only" aria-label="Import PNG character parts" onChange={chooseParts} />
    </div>
    <div className="character-workspace">
      <div className={`character-stage ${mode === 'rig' ? 'editing' : ''}`}>
        <canvas ref={canvasRef} width={STAGE_WIDTH} height={STAGE_HEIGHT} aria-label={mode === 'rig' ? 'Character joint editor: select a joint, then click or drag to position it' : 'PNG character following the extracted motion'}
          style={{ width: '100%', display: 'block', touchAction: mode === 'rig' ? 'none' : 'auto', cursor: mode === 'rig' ? 'crosshair' : 'default' }}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragJoint.current = null; }} onPointerCancel={() => { dragJoint.current = null; }} />
        <div className="character-status" role="status">{loading ? 'Preparing character parts…' : status}</div>
        <div className="character-caption" dir="ltr">{rig?.name} <span> / </span> {mode === 'rig' ? 'REST RIG' : 'LOCAL ANGLES → PNG PIVOTS'}</div>
      </div>
      <div className="character-controls">
        <label className="character-field" htmlFor="motion-strength">Motion strength<span dir="ltr">{strength.toFixed(2)}×</span>
          <input id="motion-strength" type="range" min="0" max="2" step=".05" value={strength} onChange={event => setStrength(Number(event.target.value))} />
        </label>
        <label className="character-check"><input type="checkbox" checked={inPlace} onChange={event => setInPlace(event.target.checked)} /> In place</label>
        <p className="field-note">In place fixes the pelvis position while keeping the body motion.</p>
        <label className="character-check"><input type="checkbox" checked={showBones} onChange={event => setShowBones(event.target.checked)} /> Show joints during motion</label>
        {mode === 'rig' && <>
          <label className="field-label" htmlFor="active-character-joint">Selected joint</label>
          <select id="active-character-joint" value={activeJoint} onChange={event => setActiveJoint(event.target.value as JointName)}>{JOINT_NAMES.map(name => <option key={name} value={name}>{JOINT_LABELS[name]}</option>)}</select>
          <p className="character-note">Drag points over the image, or select a joint and click its position. Left and right refer to the character.</p>
          {sourceImage && <>
            <p className="character-note">Experimental geometric cutout from a single image. Edges or gaps may appear as parts rotate. Separately drawn parts give better results.</p>
            <button className="analyze-button" disabled={loading} onClick={recut}>{cutDirty ? 'Recut with edited joints' : 'Apply cutout and preview'}</button>
          </>}
          <label className="field-label" htmlFor="active-character-part">Part and layer order</label>
          <select id="active-character-part" value={selectedBone} onChange={event => setSelectedBone(event.target.value as BoneName)}>{BONE_NAMES.map(name => <option key={name} value={name}>{BONE_LABELS[name]}</option>)}</select>
          {selectedPart && <>
            <div className="character-part-row"><span dir="auto">{selectedPart.name}</span><button title="Move part backward" aria-label="Move part backward" onClick={() => shiftLayer(selectedPart, -1)}>↓</button><button title="Move part forward" aria-label="Move part forward" onClick={() => shiftLayer(selectedPart, 1)}>↑</button></div>
            <button onClick={() => setRig(previous => previous ? { ...previous, parts: previous.parts.filter(part => part.bone !== selectedPart.bone) } : previous)}>Hide this part</button>
            {selectedPart.source === 'imported' && <>
              <label className="field-label" htmlFor="character-part-bone">Assign part to bone</label>
              <select id="character-part-bone" value={selectedPart.bone} onChange={event => changeBone(selectedPart, event.target.value as BoneName)}>{BONE_NAMES.map(name => <option key={name} value={name}>{BONE_LABELS[name]}</option>)}</select>
              <p className="character-note">Adjust the pivot and bone tip within this part. Values are percentages of its PNG dimensions.</p>
              {anchorControl('pivot', 'x', 'Pivot X')}{anchorControl('pivot', 'y', 'Pivot Y')}
              {anchorControl('tip', 'x', 'Bone tip X')}{anchorControl('tip', 'y', 'Bone tip Y')}
            </>}
          </>}
        </>}
        <p className="character-note">{mode === 'motion' ? 'Uses the current source timing and calibration. The character supplies bone lengths; the performance supplies angles.' : 'For separate parts, use names such as head.png, torso.png, and upper_arm_L.png. Other names can be assigned manually.'}</p>
      </div>
    </div>
    {(error || result.error) && <div className="character-error" role="alert">{error || result.error}</div>}
  </section>;
}
