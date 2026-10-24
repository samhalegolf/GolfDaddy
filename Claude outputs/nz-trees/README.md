# NZ course trees

Two sets of the same eight trees, plus a flowering pōhutukawa in each:

- **Low-poly** (`glb/`, from `nz-trees.js`): for the watch maps, illustrated views and far distances.
- **Realistic** (`glb-realistic/`, from `nz-trees-real.js`): for the photo map up close. See the end of this file.

## Low-poly set

| File | Tree | Height | Crown radius | Triangles |
|---|---|---|---|---|
| radiata-pine.glb | Radiata pine (*Pinus radiata*) | 28 m | 8.0 m | 1,971 |
| macrocarpa.glb | Macrocarpa (*Cupressus macrocarpa*) | 17.3 m | 9.5 m | 2,173 |
| poplar.glb | Lombardy poplar (*Populus nigra* 'Italica') | 24.5 m | 3.6 m | 1,051 |
| willow.glb | Weeping willow (*Salix babylonica*) | 11.8 m | 7.4 m | 2,886 |
| eucalyptus.glb | Eucalyptus (*Eucalyptus* spp.) | 24 m | 6.7 m | 1,244 |
| pohutukawa.glb | Pōhutukawa (*Metrosideros excelsa*) | 13.9 m | 10.4 m | 2,828 |
| pohutukawa-flowering.glb | the same tree in bloom | | | |
| cabbage-tree.glb | Cabbage tree / tī kōuka (*Cordyline australis*) | 6.6 m | 1.7 m | 899 |
| native-broadleaf.glb | Generic native evergreen | 11 m | 4.8 m | 1,055 |

## What they are

- glTF 2.0 binary, validated with the Khronos glTF validator (0 errors, 0 warnings).
- Real-world metres, Y up, origin at the base of the main trunk.
- Flat-shaded triangle list: POSITION, NORMAL, COLOR_0. No textures, one double-sided material, so each tree is one draw call.
- The mesh's `extras` carry `species`, `heightM`, `crownRadiusM` and `billboardType`.
  To stand a model on a tree marker: `scale = marker.r / extras.crownRadiusM`.
  `billboardType` is the nearest of the app's existing billboard types (0 round, 1 broadleaf, 2 pine, 3 yellow-green), for anywhere that still draws billboards.

## Changing them

`nz-trees.js` is the only source. It works in the browser (`window.NZTrees`) and is what the Design canvas preview runs, so the preview and the files always match.

```
node build-glb.mjs            # rewrites glb/*.glb and glb/index.json
```

`NZTrees.build(id, { seed })` gives a different individual of the same species, for variety along a tree line.

## Realistic set (photo map)

| File | Height | Crown radius | Triangles | Size |
|---|---|---|---|---|
| radiata-pine.glb | 28 m | 7.2 m | 12.9k | 1.4 MB |
| macrocarpa.glb | 16 m | 8.1 m | 12.7k | 2.0 MB |
| poplar.glb | 24 m | 3.6 m | 11.4k | 0.8 MB |
| willow.glb | 11 m | 6.6 m | 4.2k | 0.9 MB |
| eucalyptus.glb | 26.5 m | 10.9 m | 6.9k | 0.9 MB |
| pohutukawa.glb / pohutukawa-flowering.glb | 13 m | 10.3 m | 13.7k | 1.1 MB |
| cabbage-tree.glb | 7 m | 2.2 m | 10.1k | 1.4 MB |
| native-broadleaf.glb | 10.7 m | 5.5 m | 5.3k | 0.7 MB |

How they are built:

- A real branch skeleton per species (trunk, limbs, branches, twigs), as smooth bark tubes with a
  tiling 256 px bark texture: fissured plates (pine, poplar, willow), stringy (macrocarpa,
  pōhutukawa), shedding gum, smooth grey, corky (cabbage tree).
- Foliage is alpha-cut cards carrying a 1024 px atlas painted per species: needles in threes,
  cypress sprays, sickle gum leaves, willow strands, pōhutukawa leaves with pale undersides and
  crimson stamen heads. Cabbage-tree leaves are real strap geometry with a dead-leaf skirt.
- Two primitives per file: `bark` (opaque, REPEAT) and `leaves` (`alphaMode: MASK`, cutoff 0.45).
  Leaves are written front and back with normals pointing out from the crown, so the material is
  single-sided and a crown shades as one soft volume. COLOR_0 holds the shading inside the crown
  and multiplies the texture.
- Same `extras` as the low-poly set: `scale = marker.r / crownRadiusM`.
- All validated with the Khronos glTF validator: 0 errors, 0 warnings.

For production, convert the PNG textures to KTX2 (e.g. `gltf-transform etc1s`) and use the
low-poly set for trees further away, to keep download size and GPU memory down on phones.

```
node build-glb-real.mjs          # rewrites glb-realistic/*.glb and index.json
```
