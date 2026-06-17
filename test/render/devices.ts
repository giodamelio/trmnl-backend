// Device/palette presets for rendering a view into a real e-ink screen box.
// Mirrors what the trmnlp /full dropdowns POST (web/public/index.js) and the
// render recipe in CLAUDE.md: width = model.width / scale_factor, color_depth =
// ceil(log2(grays)), plus the screen_classes that drive the framework CSS.
export interface DevicePreset {
  label: string;
  width: number;
  height: number;
  colorDepth: number;
  screenClasses: string;
}

// A view doesn't fill the whole screen — in a TRMNL mashup each occupies a slot:
// half_horizontal = a top/bottom band (full width, half height), half_vertical =
// a left/right column (half width, full height), quadrant = one corner. Render
// each at its slot size so the snapshot matches how the view is actually shown,
// rather than stretching a half-view across the full panel.
export function viewBox(device: DevicePreset, view: string): { width: number; height: number } {
  const { width: w, height: h } = device;
  switch (view) {
    case "half_horizontal":
      return { width: w, height: Math.round(h / 2) };
    case "half_vertical":
      return { width: Math.round(w / 2), height: h };
    case "quadrant":
      return { width: Math.round(w / 2), height: Math.round(h / 2) };
    default: // full
      return { width: w, height: h };
  }
}

export const DEVICES: Record<string, DevicePreset> = {
  // TRMNL X is the only device we support: 1872x1404 native, scale_factor 1.8 ->
  // 1040x780 render, 16 greys (4-bit). This is the default for all rendering/tests.
  x: {
    label: "TRMNL X (1040x780, 4-bit)",
    width: 1040,
    height: 780,
    colorDepth: 4,
    screenClasses: "screen screen--4bit screen--v2 screen--lg screen--1x",
  },
  // Original 800x480 1-bit panel — kept only as a reference recipe; NOT supported,
  // not exercised by the suite.
  og: {
    label: "OG (800x480, 1-bit)",
    width: 800,
    height: 480,
    colorDepth: 1,
    screenClasses: "screen",
  },
};

// The device the suite renders against. We only support TRMNL X.
export const DEVICE: DevicePreset = DEVICES.x;
