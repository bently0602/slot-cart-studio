# Roomier editor modals

Status: complete

Increase the preferred editor size from 430 × 620 to 620 × 800 while preserving
centering, masking, and a 10-pixel margin on smaller screens. Size cartridge choice
panels from the form's available width so scrolling does not clip their controls.
Verify existing modal and editing workflows, then refresh desktop downloads.

Verification:

- Existing modal, cartridge editing/history, music replacement, and mixed-card
  export checks pass. Smaller-screen screenshots were inspected.
- Choice panels account for the scrollbar; artwork and native fieldsets shrink
  within the available space, avoiding clipped controls on narrow screens.
- Both desktop targets and ZIPs were rebuilt and verified; Windows packaged
  integration passes. The running original executable was preserved.
