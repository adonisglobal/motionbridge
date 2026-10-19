import { lazy, Suspense, useEffect, useState } from 'react';
import App from './App';
import '../studio3d/studio3d.css';

const Studio3D = lazy(() => import('../studio3d/Studio3D'));

export default function Workspace() {
  const [mode, setMode] = useState<'3d' | '2d'>('3d');
  useEffect(() => {
    const hiddenPanel = document.getElementById(mode === '3d' ? 'workspace-panel-2d' : 'workspace-panel-3d');
    hiddenPanel?.querySelectorAll('video').forEach(video => video.pause());
  }, [mode]);
  return <>
    <div className="workspace-modebar">
      <span className="workspace-mode-label">MOTION WORKSPACE</span>
      <div role="tablist" aria-label="Animation workspace">
        <button id="workspace-tab-3d" role="tab" aria-selected={mode === '3d'} aria-controls="workspace-panel-3d" tabIndex={mode === '3d' ? 0 : -1} onClick={() => setMode('3d')} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { setMode('2d'); document.getElementById('workspace-tab-2d')?.focus(); } }}>3D <span>Blender</span></button>
        <button id="workspace-tab-2d" role="tab" aria-selected={mode === '2d'} aria-controls="workspace-panel-2d" tabIndex={mode === '2d' ? 0 : -1} onClick={() => setMode('2d')} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { setMode('3d'); document.getElementById('workspace-tab-3d')?.focus(); } }}>2D <span>PNG / OpenToonz</span></button>
      </div>
      <span className="workspace-mode-hint">Independent sessions · local media</span>
    </div>
    <div id="workspace-panel-3d" role="tabpanel" aria-labelledby="workspace-tab-3d" hidden={mode !== '3d'}>
      <Suspense fallback={<p className="studio3d-loading">Preparing the 3D workspace…</p>}><Studio3D active={mode === '3d'} /></Suspense>
    </div>
    <div id="workspace-panel-2d" role="tabpanel" aria-labelledby="workspace-tab-2d" hidden={mode !== '2d'}><App /></div>
  </>;
}
