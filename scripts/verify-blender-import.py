"""Numerically verify real Blender BVH import, save an animated .blend and render QA.

node scripts/verify-blender-fixture.mjs
blender --background --factory-startup --python scripts/verify-blender-import.py -- .local/blender-qa
"""
from pathlib import Path
import importlib.util
import json
import math
import sys

import bpy
from bpy_extras.io_utils import axis_conversion
from mathutils import Matrix, Quaternion, Vector

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = Path(sys.argv[sys.argv.index("--") + 1]).resolve() if "--" in sys.argv else ROOT / ".local" / "blender-qa"
with (DIRECTORY / "verification.expected.json").open(encoding="utf-8") as stream:
    expected = json.load(stream)
spec = importlib.util.spec_from_file_location("motion3d_import", ROOT / "blender" / "import_motion.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
armature = helper.import_motion(DIRECTORY / "verification.motion3d.bvh")
scene = bpy.context.scene
conversion = axis_conversion(from_forward="-Z", from_up="Y").to_4x4()
position_error = 0.0
end_error = 0.0
rotation_error = 0.0
for frame in expected["frames"]:
    scene.frame_set(frame["frame"])
    bpy.context.view_layer.update()
    for name, position in frame["positions"].items():
        bone = armature.pose.bones[name]
        world_head = armature.matrix_world @ bone.head
        wanted = conversion @ Vector((position["x"], position["y"], position["z"]))
        position_error = max(position_error, (world_head - wanted).length)
        # Blender's rest bones orient local Y along a display bone. Recover the
        # authored transform by undoing that display basis before comparison.
        actual = armature.matrix_world.to_3x3() @ bone.matrix.to_3x3() @ armature.data.bones[name].matrix_local.to_3x3().inverted()
        q = frame["worldRotations"][name]
        wanted_rotation = conversion.to_3x3() @ Quaternion((q["w"], q["x"], q["y"], q["z"])).to_matrix() @ conversion.to_3x3().inverted()
        angle = actual.to_quaternion().rotation_difference(wanted_rotation.to_quaternion()).angle
        rotation_error = max(rotation_error, min(angle, math.tau - angle))
    for name, position in frame["ends"].items():
        actual = armature.matrix_world @ armature.pose.bones[name].tail
        wanted = conversion @ Vector((position["x"], position["y"], position["z"]))
        end_error = max(end_error, (actual - wanted).length)
actual_fps = scene.render.fps / scene.render.fps_base
assert len(armature.pose.bones) == len(expected["skeleton"]["bones"])
assert scene.frame_start == 1 and scene.frame_end == expected["frameCount"]
assert abs(actual_fps - expected["fps"]) < 1e-6
assert scene.unit_settings.system == "METRIC" and scene.unit_settings.scale_length == 1
assert position_error < 2e-5, f"Blender imported joint error: {position_error} m"
assert end_error < 2e-5, f"Blender imported end-site error: {end_error} m"
# Blender matrices use float32; angular differences below this threshold are noise.
assert rotation_error < 0.0015, f"Blender imported rotation error: {rotation_error} rad"

# A small generated skinned mannequin makes the saved Blender animation easy to inspect.
material = bpy.data.materials.new("Motion3D mint")
material.diffuse_color = (0.16, 0.72, 0.57, 1)
material.use_nodes = True
material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.16, 0.72, 0.57, 1)
def attach(obj, bone_name):
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    modifier = obj.modifiers.new("Motion3D armature", "ARMATURE")
    modifier.object = armature
    obj.data.materials.append(material)
    obj.matrix_world = armature.matrix_world.copy()

def cylinder_between(a, b, bone_name, radius):
    direction = b - a
    if direction.length < 1e-5:
        return
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=direction.length)
    obj = bpy.context.object
    obj.name = f"Preview_{bone_name}"
    transform = direction.to_track_quat("Z", "Y").to_matrix().to_4x4()
    transform.translation = (a + b) * 0.5
    obj.data.transform(transform)
    attach(obj, bone_name)

for name, bone in expected["skeleton"]["bones"].items():
    if bone["parent"]:
        parent = bone["parent"]
        a = armature.data.bones[parent].head_local
        b = armature.data.bones[name].head_local
        cylinder_between(a, b, parent, 0.06 if parent in {"hips", "spine", "chest"} else 0.035)
for name, bone in expected["skeleton"]["bones"].items():
    if "endOffset" in bone and name != "head":
        cylinder_between(armature.data.bones[name].head_local, armature.data.bones[name].tail_local, name, 0.04)
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.11)
head = bpy.context.object
head.name = "Preview_head"
head_bone = armature.data.bones["head"]
head.data.transform(Matrix.Translation(head_bone.head_local + (head_bone.tail_local - head_bone.head_local).normalized() * 0.08))
attach(head, "head")

scene.frame_set(max(1, expected["frameCount"] // 2))
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = 900, 900
scene.render.resolution_percentage = 100
scene.world.color = (0.05, 0.05, 0.05)
bpy.ops.object.camera_add(location=(3.0, -4.5, 2.6))
camera = bpy.context.object
camera.rotation_euler = (Vector((0.2, 0, 1.0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type, camera.data.ortho_scale = "ORTHO", 2.8
scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(2, -3, 4))
bpy.context.object.data.energy = 700
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 5
bpy.context.object.rotation_euler = (Vector((0, 0, 1)) - bpy.context.object.location).to_track_quat("-Z", "Y").to_euler()
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(DIRECTORY / "verification.blender.png")
bpy.ops.wm.save_as_mainfile(filepath=str(DIRECTORY / "verification.blend"))
bpy.ops.render.render(write_still=True)
report = {"blenderVersion": bpy.app.version_string, "jointCount": len(armature.pose.bones), "frameCount": expected["frameCount"],
          "fps": actual_fps, "positionErrorMeters": position_error, "endSiteErrorMeters": end_error,
          "rotationErrorRadians": rotation_error, "units": "meters", "passed": True}
(DIRECTORY / "verification.report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("MOTION3D_BLENDER_VERIFIED " + json.dumps(report))
