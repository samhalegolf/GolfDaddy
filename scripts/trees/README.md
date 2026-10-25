# NZ course trees

Two sets of the same eight New Zealand trees, from two generators that run in the browser
and in Node:

| Species id | Tree |
|---|---|
| radiata-pine | Radiata pine (*Pinus radiata*) |
| macrocarpa | Macrocarpa (*Cupressus macrocarpa*) |
| poplar | Lombardy poplar (*Populus nigra* 'Italica') |
| willow | Weeping willow (*Salix babylonica*) |
| eucalyptus | Eucalyptus (*Eucalyptus* spp.) |
| pohutukawa | Pōhutukawa (*Metrosideros excelsa*), plain or `{ flowering: true }` |
| cabbage-tree | Cabbage tree / tī kōuka (*Cordyline australis*) |
| native-broadleaf | Generic native evergreen (karaka, pūriri, tītoki and the like) |

- `nz-trees.js` (`window.NZTrees`): low-poly, flat-shaded, vertex colour only, 900-2,900
  triangles. For the watch maps, the Illustrated view and trees far from the camera.
- `nz-trees-real.js` (`window.NZTreesReal`): realistic. A branch skeleton with tiling bark
  textures, and foliage as alpha-cut cards painted per species (needles in threes, cypress
  sprays, gum leaves, willow strands, pōhutukawa with pale leaf undersides and crimson flowers).
  Cabbage-tree leaves are real strap geometry. 4,000-14,000 triangles. For the photo map up
  close. `mipLevels()` builds distance textures that keep thin leaves from vanishing.
- `tree-species.js` (`window.GDTreeSpecies`): guesses each tree's species from the aerial
  photo, mapped water and latitude. Nobody tags trees. See its header for how it decides.

All models: real-world metres, Y up, origin at the base of the main trunk, deterministic per
species (`build(id, { seed })` for another individual). `meta.crownRadiusM` sizes a model
to a tree marker: `scale = marker.r / crownRadiusM`.

## Where they are used

The Studio 3D Course Viewer (`scripts/studio/courses/course-3d/course-3d-page.js`) builds
both sets in the browser and stands a model at every tree marker, with the species from
`tree-species.js`. On the photo, the nearest trees (within 180 m, at most 300) use the
realistic models and the rest use low-poly. Illustrated uses low-poly throughout. GPS Play and
the watches still use their own trees.

## Exporting .glb files

```
node scripts/trees/build-glb.mjs <output folder>        # low-poly
node scripts/trees/build-glb-real.mjs <output folder>   # realistic, PNG textures embedded
```

Each file is glTF 2.0 with the species, height and crown radius in the mesh's `extras`.
Realistic files have two primitives: `bark` (opaque) and `leaves` (`alphaMode: MASK`, cutoff
0.45, single-sided because every card is written front and back). Both sets pass the Khronos
glTF validator. For use in an app, convert the PNG textures to KTX2 first.

Tests: `npm run test:tree-species`.
