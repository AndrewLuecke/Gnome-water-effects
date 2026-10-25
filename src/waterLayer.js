import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MAX_WINDOWS, WaterEffect} from './waterEffect.js';

// Windows this close to the water show in the reflection, counting shadows
const SHADOW_ALLOWANCE = 64;

// The water along the bottom of one monitor. It holds live copies of the
// wallpaper and the windows, flipped about the water line, and WaterEffect
// turns them into the reflection.
//
// The layer is drawn just above the windows rather than below them. While
// GNOME paints the windows it clips each one to the parts that changed, and a
// copy painted at the same time would be clipped too. Above the windows the
// copies come out whole, and the shader leaves holes where windows sit in
// front of the water.
export const WaterLayer = GObject.registerClass(
class WaterLayer extends Clutter.Actor {
    constructor(monitorIndex) {
        super({clip_to_allocation: true});

        this.monitorIndex = monitorIndex;
        this.band = null;

        this.waterEffect = new WaterEffect();
        this.add_effect(this.waterEffect);

        this._mirror = new Clutter.Actor();
        this.add_child(this._mirror);

        this._backgroundClone = cloneOf(Main.layoutManager._backgroundGroup);
        this._mirror.add_child(this._backgroundClone);

        this._windowClones = new Map();
        this._origin = [0, 0];
        this._reflected = null;
    }

    /**
     * @param {object} monitor - the monitor's geometry
     * @param {number} waterLine - stage y of the water line
     * @param {number} depth - depth of the water
     * @param {number} swell - how far the waves rise above the line
     * @param {number} margin - rows above the line and below the screen that
     *   the ripples may read from
     */
    setGeometry(monitor, waterLine, depth, swell, margin) {
        const top = waterLine - margin;
        const bottom = monitor.y + monitor.height;
        const height = bottom + margin - top;

        this.set_position(monitor.x, top);
        this.set_size(monitor.width, height);
        this._origin = [monitor.x, top];

        // Flip the stage about the water line, then move it into the layer
        const matrix = new Graphene.Matrix().init_scale(1, -1, 1);
        matrix.translate(new Graphene.Point3D({x: -monitor.x, y: 2 * waterLine - top, z: 0}));
        this._mirror.set_transform(matrix);

        this.waterEffect.setGeometry(monitor.width, height, margin, depth, bottom - top);

        this.band = {x: monitor.x, y: waterLine - swell, width: monitor.width, height: depth + swell};
        this._reflected = {
            x1: monitor.x,
            y1: waterLine - depth - margin - SHADOW_ALLOWANCE,
            x2: monitor.x + monitor.width,
            y2: bottom + SHADOW_ALLOWANCE,
        };
    }

    /**
     * Keeps a copy of each window, stacked in the same order.
     *
     * @param {Meta.WindowActor[]} windowActors - from bottom to top
     */
    syncWindows(windowActors) {
        const current = new Set(windowActors);
        for (const [windowActor, clone] of this._windowClones) {
            if (!current.has(windowActor))
                clone.destroy();
        }

        let below = this._backgroundClone;
        for (const windowActor of windowActors) {
            const clone = this._windowClones.get(windowActor) ??
                this._addWindowClone(windowActor);
            if (clone.get_previous_sibling() !== below)
                this._mirror.set_child_above_sibling(clone, below);
            below = clone;
        }
    }

    /**
     * Shows the copies of windows near the water and hides the rest, so
     * GNOME can still skip work for windows buried behind others, and tells
     * the shader which windows are in front of the water.
     *
     * @param {object[]} windows - visible windows from bottom to top, each
     *   with its actor and frame rect
     */
    updateWindows(windows) {
        const near = new Set();
        const rects = [];
        const [x0, y0] = this._origin;
        const {x1, y1, x2, y2} = this._reflected;

        for (const {actor, frame} of windows) {
            if (frame.x < x2 && frame.y < y2 &&
                frame.x + frame.width > x1 && frame.y + frame.height > y1)
                near.add(actor);

            const rect = [
                frame.x - x0, frame.y - y0,
                frame.x + frame.width - x0, frame.y + frame.height - y0,
            ];
            if (rect[2] > 0 && rect[3] > 0 && rect[0] < this.width && rect[1] < this.height)
                rects.push(rect);
        }

        for (const [windowActor, clone] of this._windowClones)
            clone.visible = near.has(windowActor);

        // Windows are listed bottom to top, so keep the topmost
        this.waterEffect.setWindows(rects.slice(-MAX_WINDOWS));
    }

    _addWindowClone(windowActor) {
        const clone = cloneOf(windowActor);
        const binding = windowActor.bind_property('opacity', clone, 'opacity',
            GObject.BindingFlags.SYNC_CREATE);

        windowActor.connectObject('destroy', () => clone.destroy(), clone);
        clone.connect('destroy', () => {
            binding.unbind();
            this._windowClones.delete(windowActor);
        });

        this._windowClones.set(windowActor, clone);
        this._mirror.add_child(clone);
        return clone;
    }
});

function cloneOf(source) {
    const clone = new Clutter.Clone({source});
    clone.add_constraint(new Clutter.BindConstraint({
        source,
        coordinate: Clutter.BindCoordinate.ALL,
    }));
    return clone;
}
