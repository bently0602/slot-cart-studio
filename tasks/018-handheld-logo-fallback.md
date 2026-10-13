# Extend the logo fallback to handheld cartridges

Status: complete

Use the same hosted-logo-first, libretro Named_Logos fallback for GBA, GB, and GBC
as SNES. Preserve matching, regional aliases, cartridge sizing, saving, hosted
artwork preference, and PSX box-art behavior. Verify each platform and refresh
the desktop packages.

The live GBA and GB repositories have logos. The GBC repository currently has
box art/screenshots but no Named_Logos folder; enable its lookup while preserving
imports and existing artwork when the provider returns no logo.

Verification:

- All 29 automated browser cases pass. The two network-dependent live checks are
  skipped in normal runs; the new live handheld check passes separately with
  Pokemon Emerald (GBA) and Pokemon Red (GB).
- Each handheld requests its own repository, prefers valid hosted logos, releases
  loading masks when no fallback exists, and retains manual import controls.
  Direct saves preserve platform folders and export 1280 x 661 GBA labels and
  1024 x 901 GB/GBC labels.
- The live GBC repository contents confirm there is no Named_Logos folder. This
  provider limitation is documented; existing hosted GBC artwork is retained.
- Both desktop targets and archives were rebuilt and verified. Windows packaged
  integration passes, including embedded source equality.
