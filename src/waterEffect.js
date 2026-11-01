import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

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
// This pixel's position in the layer. The texture is a little bigger than the
// layer, so its coordinates are mapped through u_box.
vec2 pos = u_box.xy + cogl_tex_coord0_in.st * u_box.zw;
float depth = u_water.y;
// E16's movements were for 64 px of water at full strength
float scale = u_style.x * depth / 64.0;

// Waves: the surface rises and falls in a swell that rolls across the screen.
float swell = u_style.y * sin(u_phase.z + (pos.x / 64.0 + 1.0) * 0.42) * 10.0 * scale;
// y is how far below the surface this pixel is
float y = pos.y - u_water.x - swell;

// No water above the surface, in the margin below the screen, or where a
// window is in front of it
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
    // yoff is how far from the line to read the reflection, nudged up and
    // down by the ripples. xoff shifts it sideways, more the further this
    // pixel is from the line.
    float yoff = y + sin(pp * 48.0 + u_phase.x) * 7.0 * scale;
    float xoff = sin(pp * 64.0 + u_phase.y) * 10.0 * scale * (1.0 - p);
    // E16 reads yoff rows above the line. The layer is already flipped, so
    // those rows are yoff below it here. Clamping keeps the read half a
    // pixel inside the layer, so filtering doesn't pull in what lies outside.
    vec2 src = clamp(vec2(pos.x - xoff, u_water.x + yoff), vec2(0.5), u_size - 0.5);
    cogl_color_out = texture2D(cogl_sampler0, (src - u_box.xy) / u_box.zw) * cogl_color_in;
}
`;

// ClutterOffscreenEffect renders into a texture that covers the actor's box
// grown by _clutter_actor_box_enlarge_for_effects(), so it is 3 px bigger than
// the actor and starts a little above and to the left of it.
//
// Returns the x, y, width and height of the texture, relative to the actor.
function offscreenBox(width, height) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    const x2 = Math.ceil(width + 0.75);
    const y2 = Math.ceil(height + 0.75);
    return [x2 - roundedWidth - 3, y2 - roundedHeight - 3, roundedWidth + 3, roundedHeight + 3];
}

// Clutter.ShaderEffect paints the layer into an offscreen texture, then paints
// that texture through the shader.
export const WaterEffect = GObject.registerClass(
class WaterEffect extends Clutter.ShaderEffect {
    constructor(params) {
        super(params);

        // u_windows, flattened, for vfunc_paint_target() to set
        this._windows = new Array(MAX_WINDOWS * 4).fill(0);
        // Looked up on the first paint, once there is a pipeline
        this._windowsLocation = -1;
    }

    // Called once, and the snippet shared by every WaterEffect
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
    }

    // set_uniform_float() holds at most four floats, so the windows go
    // straight onto the pipeline. ClutterOffscreenEffect makes a new one
    // when the layer is resized, so they are set on every paint.
    vfunc_paint_target(node, paintContext) {
        const pipeline = this.get_pipeline();
        if (this._windowsLocation < 0)
            this._windowsLocation = pipeline.get_uniform_location('u_windows');
        pipeline.set_uniform_float(this._windowsLocation, 4, MAX_WINDOWS, this._windows);

        super.vfunc_paint_target(node, paintContext);
    }

    /**
     * @param {number} width - width of the layer in logical pixels
     * @param {number} height - height of the layer
     * @param {number} waterLine - y of the water line, relative to the layer
     * @param {number} depth - depth of the water below the line
     * @param {number} bottom - y of the bottom of the screen, relative to the layer
     */
    setGeometry(width, height, waterLine, depth, bottom) {
        this.set_uniform_float('u_size', 2, [width, height]);
        this.set_uniform_float('u_box', 4, offscreenBox(width, height));
        this.set_uniform_float('u_water', 3, [waterLine, depth, bottom]);
        this.queue_repaint();
    }

    /**
     * @param {number} amplitude - ripple strength relative to E16
     * @param {boolean} waves - whether to add the rolling swell
     */
    setStyle(amplitude, waves) {
        this.set_uniform_float('u_style', 2, [amplitude, waves ? 1 : 0]);
        this.queue_repaint();
    }

    /**
     * Doesn't queue a repaint, since the timer that calls it does.
     *
     * @param {number[]} phases - E16's incv, inch and incx, in radians
     */
    setPhases(phases) {
        this.set_uniform_float('u_phase', 3, phases);
    }

    /**
     * Called before every frame. The rects reach the shader on the next paint.
     *
     * @param {number[][]} rects - x1, y1, x2, y2 of each window in front of
     *   the water, relative to the layer; at most MAX_WINDOWS
     */
    setWindows(rects) {
        const values = new Array(MAX_WINDOWS * 4).fill(0);
        rects.forEach((rect, i) => values.splice(i * 4, 4, ...rect));
        this._windows = values;
        this.set_uniform_float('u_window_count', 1, [rects.length]);
    }
});
