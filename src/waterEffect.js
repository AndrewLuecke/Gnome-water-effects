import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// Most windows a layer can leave holes for
export const MAX_WINDOWS = 16;

// The shader runs over a WaterLayer, which holds an upside-down copy of the
// desktop and windows flipped about the water line. Below the line it draws
// that copy with E16's ripples; everywhere else, and wherever a window sits in
// front of the water, it leaves the layer transparent.
//
// The constants are lifted from FX_ripple_timeout() and FX_Wave_timeout() in
// E16's fx.c, which were tuned for a 64 px band of water.
const DECLARATIONS = `
uniform vec2 u_size;  // layer size in logical pixels
uniform vec4 u_box;   // area the offscreen texture covers, relative to the layer
uniform vec3 u_water; // y of the water line, depth of the water, y of the screen bottom
uniform vec3 u_phase; // E16's incv, inch and incx
uniform vec2 u_style; // amplitude scale, 1.0 to add the rolling swell
uniform vec4 u_windows[${MAX_WINDOWS}]; // x1, y1, x2, y2 of windows in front of the water
uniform float u_window_count;
`;

const CODE = `
vec2 pos = u_box.xy + cogl_tex_coord0_in.st * u_box.zw;
float depth = u_water.y;
float scale = u_style.x * depth / 64.0;

// Waves: the surface rises and falls in a swell that rolls across the screen.
float swell = u_style.y * sin(u_phase.z + (pos.x / 64.0 + 1.0) * 0.42) * 10.0 * scale;
float y = pos.y - u_water.x - swell;

bool dry = y < 0.0 || pos.y >= u_water.z;
for (int i = 0; i < ${MAX_WINDOWS}; i++) {
    if (float(i) >= u_window_count)
        break;
    vec4 rect = u_windows[i];
    if (pos.x >= rect.x && pos.y >= rect.y && pos.x < rect.z && pos.y < rect.w)
        dry = true;
}

if (dry) {
    cogl_color_out = vec4(0.0);
} else {
    // p falls from 1 at the water line to 0 at the bottom. Squaring it packs
    // the ripples together towards the horizon.
    float p = clamp((depth - y) / depth, 0.0, 1.0);
    float pp = p * p;
    float yoff = y + sin(pp * 48.0 + u_phase.x) * 7.0 * scale;
    float xoff = sin(pp * 64.0 + u_phase.y) * 10.0 * scale * (1.0 - p);
    // E16 reads yoff rows above the line. The layer is already flipped, so
    // those rows are yoff below it here.
    vec2 src = clamp(vec2(pos.x - xoff, u_water.x + yoff), vec2(0.5), u_size - 0.5);
    cogl_color_out = texture2D(cogl_sampler0, (src - u_box.xy) / u_box.zw) * cogl_color_in;
}
`;

// ClutterOffscreenEffect renders into a texture that covers the actor's box
// grown by _clutter_actor_box_enlarge_for_effects(), so it is 3 px bigger than
// the actor and starts a little above and to the left of it.
function offscreenBox(width, height) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    const x2 = Math.ceil(width + 0.75);
    const y2 = Math.ceil(height + 0.75);
    return [x2 - roundedWidth - 3, y2 - roundedHeight - 3, roundedWidth + 3, roundedHeight + 3];
}

export const WaterEffect = GObject.registerClass(
class WaterEffect extends Shell.GLSLEffect {
    constructor(params) {
        super(params);

        this._sizeLocation = this.get_uniform_location('u_size');
        this._boxLocation = this.get_uniform_location('u_box');
        this._waterLocation = this.get_uniform_location('u_water');
        this._phaseLocation = this.get_uniform_location('u_phase');
        this._styleLocation = this.get_uniform_location('u_style');
        this._windowsLocation = this.get_uniform_location('u_windows');
        this._windowCountLocation = this.get_uniform_location('u_window_count');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    /**
     * @param {number} width - width of the layer in logical pixels
     * @param {number} height - height of the layer
     * @param {number} waterLine - y of the water line, relative to the layer
     * @param {number} depth - depth of the water below the line
     * @param {number} bottom - y of the bottom of the screen, relative to the layer
     */
    setGeometry(width, height, waterLine, depth, bottom) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.set_uniform_float(this._boxLocation, 4, offscreenBox(width, height));
        this.set_uniform_float(this._waterLocation, 3, [waterLine, depth, bottom]);
        this.queue_repaint();
    }

    /**
     * @param {number} amplitude - ripple strength relative to E16
     * @param {boolean} waves - whether to add the rolling swell
     */
    setStyle(amplitude, waves) {
        this.set_uniform_float(this._styleLocation, 2, [amplitude, waves ? 1 : 0]);
        this.queue_repaint();
    }

    /**
     * @param {number[]} phases - E16's incv, inch and incx, in radians
     */
    setPhases(phases) {
        this.set_uniform_float(this._phaseLocation, 3, phases);
    }

    /**
     * @param {number[][]} rects - x1, y1, x2, y2 of each window in front of
     *   the water, relative to the layer; at most MAX_WINDOWS
     */
    setWindows(rects) {
        const values = new Array(MAX_WINDOWS * 4).fill(0);
        rects.forEach((rect, i) => values.splice(i * 4, 4, ...rect));
        this.set_uniform_float(this._windowsLocation, 4, values);
        this.set_uniform_float(this._windowCountLocation, 1, [rects.length]);
    }
});
