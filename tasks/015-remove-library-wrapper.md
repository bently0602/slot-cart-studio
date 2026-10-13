# Remove the Library wrapper panel

Status: complete

Make the platform TabPanel the Viewport's direct center region. Remove the outer
Library heading and its separate toolbar. Move the fill action into the main
toolbar and retain genuine notices in the header. Preserve wrapping, scrolling,
platform switching, modal masks, and viewport resizing. Refresh desktop downloads.

Verification:

- All 16 browser workflows pass. The TabPanel is a direct Viewport child;
  scrolling, resizing, notices, loading masks, and editor masks remain usable.
- Desktop and mobile screenshots were inspected. The header grows naturally
  for genuine notices and the tabs use the freed space.
- Both desktop targets and ZIPs were rebuilt and verified; Windows packaged
  integration passes. The running original executable was preserved.
