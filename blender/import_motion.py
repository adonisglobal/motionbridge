"""Import a Motion3D BVH with its authored units, timing, and coordinate axes.

From Blender's Python console:
    exec(compile(open('/path/to/blender/import_motion.py').read(), 'import_motion.py', 'exec'))
    import_motion('/path/to/capture.motion3d.bvh')

Or from a terminal:
    blender --background --python blender/import_motion.py -- capture.motion3d.bvh output.blend

This imports an animated source armature. Binding an existing character mesh
requires retargeting its bone mapping and reference pose; importing BVH does not
automatically skin an arbitrary mesh.
"""

from pathlib import Path
import math
import sys

import bpy


def _header(path):
    count = None
    interval = None
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            if line.startswith("Frames:"):
                count = int(line.split(":", 1)[1])
            elif line.startswith("Frame Time:"):
                interval = float(line.split(":", 1)[1])
                break
    if count is None or count < 1 or interval is None or not math.isfinite(interval) or interval <= 0:
        raise ValueError("The BVH has an invalid frame count or frame interval.")
    return count, 1.0 / interval


def import_motion(filepath, frame_start=1):
    """Import metre-scale Motion3D BVH and return its animated armature object."""
    path = Path(filepath).expanduser().resolve(strict=True)
    count, fps = _header(path)
    if frame_start < 1:
        raise ValueError("frame_start must be at least one.")
    if "io_anim_bvh" not in bpy.context.preferences.addons:
        bpy.ops.preferences.addon_enable(module="io_anim_bvh")
    before = set(bpy.data.objects)
    result = bpy.ops.import_anim.bvh(
        filepath=str(path),
        target="ARMATURE",
        global_scale=1.0,
        frame_start=frame_start,
        rotate_mode="QUATERNION",
        axis_forward="-Z",
        axis_up="Y",
        use_fps_scale=False,
        update_scene_fps=False,
        update_scene_duration=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError("Blender could not import the BVH animation.")
    imported = [obj for obj in bpy.data.objects if obj not in before and obj.type == "ARMATURE"]
    if len(imported) != 1:
        raise RuntimeError("Expected one imported Motion3D armature.")
    armature = imported[0]
    armature.name = path.stem
    armature.show_in_front = True
    armature["motion3d_source"] = path.name
    armature["motion3d_units"] = "meters"
    armature["motion3d_global_depth"] = "Unobserved; root XY is image-derived."
    scene = bpy.context.scene
    scene.render.fps = round(fps)
    scene.render.fps_base = round(fps) / fps
    scene.frame_start = frame_start
    scene.frame_end = frame_start + count - 1
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.frame_set(frame_start)
    return armature


if __name__ == "__main__" and "--" in sys.argv:
    arguments = sys.argv[sys.argv.index("--") + 1:]
    if not 1 <= len(arguments) <= 2:
        raise SystemExit("Usage: blender --background --python blender/import_motion.py -- input.bvh [output.blend]")
    import_motion(arguments[0])
    if len(arguments) == 2:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(arguments[1]).expanduser().resolve()))
