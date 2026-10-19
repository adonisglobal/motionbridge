"""Verify actual animated GLB import and emit a local, self-generated FBX fixture.

node scripts/verify-blender-model-fixture.mjs
blender --background --factory-startup --python-exit-code 1 --python scripts/verify-blender-model.py -- .local/blender-qa
"""
from pathlib import Path
import json
import math
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = Path(sys.argv[sys.argv.index("--") + 1]).resolve() if "--" in sys.argv else ROOT / ".local" / "blender-qa"
expected = json.loads((DIRECTORY / "animated-model.expected.json").read_text(encoding="utf-8"))
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.fps = round(expected["fps"])
scene.render.fps_base = round(expected["fps"]) / expected["fps"]
bpy.ops.import_scene.gltf(filepath=expected["input"], merge_vertices=False)
armatures = [obj for obj in scene.objects if obj.type == "ARMATURE"]
meshes = [obj for obj in scene.objects if obj.type == "MESH" and any(mod.type == "ARMATURE" for mod in obj.modifiers)]
assert len(armatures) == 1 and len(meshes) == 1, [(obj.name, obj.type) for obj in scene.objects]
armature, mesh = armatures[0], meshes[0]
assert len(armature.pose.bones) == expected["boneCount"]
assert len(mesh.data.vertices) > 100, (len(mesh.data.vertices), expected["vertexCount"])
assert sum(len(polygon.vertices) - 2 for polygon in mesh.data.polygons) == expected["triangleCount"]
assert any(mod.type == "ARMATURE" and mod.object == armature for mod in mesh.modifiers)
actions = [obj.animation_data.action for obj in scene.objects if obj.animation_data and obj.animation_data.action]
assert actions, "The GLB did not import an animation action."
start = min(action.frame_range[0] for action in actions)
end = max(action.frame_range[1] for action in actions)
duration = (end - start) / expected["fps"]
assert abs(duration - expected["durationSeconds"]) < 1e-6
conversion = Matrix.Rotation(math.pi / 2, 4, "X")
scene.frame_set(math.floor(start), subframe=start - math.floor(start))
bpy.context.view_layer.update()

def converted(point):
    return conversion @ Vector((point["x"], point["y"], point["z"]))

# Match by rest position rather than assuming Blender preserves GLB vertex order.
indices = []
for point in expected["selectedVertices"]:
    wanted = converted(point["rest"])
    index = min(range(len(mesh.data.vertices)), key=lambda i: (mesh.matrix_world @ mesh.data.vertices[i].co - wanted).length_squared)
    error = (mesh.matrix_world @ mesh.data.vertices[index].co - wanted).length
    assert error < 1e-5, f"Cannot identify fixture vertex {point['index']}: {error}, {tuple(wanted)}, {tuple(mesh.matrix_world @ mesh.data.vertices[index].co)}, matrix {mesh.matrix_world}"
    indices.append(index)

position_error = vertex_error = 0.0
for sample in expected["frames"]:
    frame = start + sample["seconds"] * expected["fps"]
    scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    for name, position in sample["positions"].items():
        actual = armature.matrix_world @ armature.pose.bones[name].head
        position_error = max(position_error, (actual - converted(position)).length)
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    deformed = evaluated.to_mesh()
    for index, position in zip(indices, sample["vertices"]):
        actual = evaluated.matrix_world @ deformed.vertices[index].co
        vertex_error = max(vertex_error, (actual - converted(position)).length)
    evaluated.to_mesh_clear()
assert position_error < 2e-5, f"GLB joint error: {position_error} m"
assert vertex_error < 2e-5, f"GLB skinned-vertex error: {vertex_error} m"
scene.frame_start = int(start)
scene.frame_end = int(end)

# Export only our generated mannequin and its baked motion; no external media.
scene.frame_set(int(start))
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.fbx(filepath=str(DIRECTORY / "animated-model.fbx"), use_selection=True,
    object_types={"ARMATURE", "MESH", "EMPTY"}, add_leaf_bones=False,
    bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
    bake_anim_simplify_factor=0.0, axis_forward="-Z", axis_up="Y",
    path_mode="AUTO", embed_textures=False)

scene.frame_set(round((start + end) / 2))
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
scene.render.filepath = str(DIRECTORY / "animated-model.blender.png")
bpy.ops.wm.save_as_mainfile(filepath=str(DIRECTORY / "animated-model.blend"))
bpy.ops.render.render(write_still=True)
report = {"blenderVersion": bpy.app.version_string, "boneCount": len(armature.pose.bones), "vertexCount": len(mesh.data.vertices),
    "triangleCount": expected["triangleCount"],
    "fps": expected["fps"], "durationSeconds": duration, "sampledPoses": len(expected["frames"]),
    "jointPositionErrorMeters": position_error, "skinnedVertexErrorMeters": vertex_error,
    "generatedFBX": "animated-model.fbx", "passed": True}
(DIRECTORY / "animated-model.report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("MOTION3D_GLB_BLENDER_VERIFIED " + json.dumps(report))
