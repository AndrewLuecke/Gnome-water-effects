import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WaterLayer} from './waterLayer.js';

// Draws E16's water along the bottom of each monitor.
//
// The extension puts one WaterLayer per monitor in a group just above the
// windows. Each layer holds a flipped copy of the desktop, and its WaterEffect
// shader turns that copy into a rippling reflection. A timer advances the
// ripples at the frame rate from the settings, and before every frame the
// layers learn where the windows are, so the water stays behind them.
//
//   extension.js   settings, signals and the animation timer
//   waterLayer.js  one monitor's water: the flipped copies and their geometry
//   waterEffect.js the shader that draws the ripples

// E16 advanced its phases by these amounts on every 66 ms tick. The three
// phases are incv and inch, which move the ripples up and down and side to
// side, and incx, which rolls the swell. Here they are in radians per second.
const E16_TICK = 0.066;
const PHASE_RATES = [0.40 / E16_TICK, 0.32 / E16_TICK, 0.32 / E16_TICK];

// How far the waves swell, and how far the ripples and swell together move
// the reflection, in pixels for a 64 px band. These match the 10.0 and 7.0
// in the shader.
const SWELL = 10;
const REACH = 7 + SWELL;

// Longest step the animation takes, so it doesn't lurch after a stall
const MAX_STEP = 0.25; // s

// How often the timer checks whether windows cover the water, since no signal
// says when a window is moved over it
const COVER_CHECK_INTERVAL = 500 * 1000; // µs

export default class WaterEffectsExtension extends Extension {
    enable() {
        // The ripples' phases, shared by every layer so the water lines up
        // across monitors
        this._settings = this.getSettings();
        this._phases = [0, 0, 0];
        this._layers = [];

        this._group = new Clutter.Actor({name: 'water-effects'});
        Main.uiGroup.insert_child_above(this._group, global.window_group);
        // Hidden with the windows in the overview and on the lock screen
        this._visibleBinding = global.window_group.bind_property('visible',
            this._group, 'visible', GObject.BindingFlags.SYNC_CREATE);

        // New monitors need new layers. Panels, fullscreen windows and
        // settings move or hide the water. Windows opening, closing and
        // restacking need their copies kept in step, and the holes follow the
        // windows on every frame.
        Main.uiGroup.connectObject('child-added', () => this._keepAboveWindows(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._createLayers(), this);
        global.display.connectObject(
            'workareas-changed', () => this._updateLayers(),
            'in-fullscreen-changed', () => this._checkCovered(),
            'restacked', () => this._syncWindows(), this);
        global.window_group.connectObject(
            'child-added', () => this._syncWindows(),
            'child-removed', () => this._syncWindows(), this);
        global.stage.connectObject('before-update', () => this._updateWindows(), this);
        this._settings.connectObject('changed', () => {
            this._updateLayers();
            this._startTimer();
        }, this);

        this._createLayers();
        this._startTimer();
    }

    disable() {
        this._stopTimer();

        Main.uiGroup.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_group.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._visibleBinding.unbind();
        this._group.destroy();

        this._visibleBinding = null;
        this._group = null;
        this._layers = null;
        this._settings = null;
    }

    // Other actors put directly above the windows, such as the workspace
    // switch animation, belong above the water too
    _keepAboveWindows() {
        if (global.window_group.get_next_sibling() !== this._group)
            Main.uiGroup.set_child_above_sibling(this._group, global.window_group);
    }

    // Starts over with one layer per monitor
    _createLayers() {
        this._group.destroy_all_children();
        this._layers = Main.layoutManager.monitors.map(monitor => {
            const layer = new WaterLayer(monitor.index);
            this._group.add_child(layer);
            return layer;
        });

        this._updateLayers();
        this._syncWindows();
    }

    // Places each layer and passes it the settings
    _updateLayers() {
        const depth = this._settings.get_int('water-height');
        const amplitude = this._settings.get_double('amplitude');
        const waves = this._settings.get_string('effect') === 'waves';
        // E16's movements were for 64 px of water, so they grow with the
        // depth as well as the strength. The layer starts a margin above the
        // water line and ends a margin below the screen, giving the ripples
        // room to read past both. The extra 2 px covers rounding.
        const scale = amplitude * depth / 64;
        const swell = waves ? Math.ceil(SWELL * scale) : 0;
        const margin = Math.ceil(REACH * scale) + 2;

        for (const layer of this._layers) {
            const monitor = Main.layoutManager.monitors[layer.monitorIndex];

            // The water sits on the bottom of the monitor, or on top of the
            // panels and docks there
            let bottom = monitor.y + monitor.height;
            if (this._settings.get_boolean('above-panels')) {
                const workArea = Main.layoutManager.getWorkAreaForMonitor(layer.monitorIndex);
                bottom = workArea.y + workArea.height;
            }

            layer.setGeometry(monitor, bottom - depth, depth, swell, margin);
            layer.waterEffect.setStyle(amplitude, waves);
            layer.waterEffect.setPhases(this._phases);
        }

        this._checkCovered();
    }

    // Gives each layer a copy of every window, in the same stacking order
    _syncWindows() {
        const windowActors = global.get_window_actors();
        for (const layer of this._layers)
            layer.syncWindows(windowActors);
    }

    // Runs before every frame, so the holes in the water follow windows as
    // they move
    _updateWindows() {
        if (!this._group.mapped)
            return;

        // Desktop windows, such as desktop icons, are part of the background
        // the water lies on, so they don't cut holes in it
        const windows = global.get_window_actors()
            .filter(actor => actor.is_mapped() && actor.opacity > 0 &&
                actor.meta_window.get_window_type() !== Meta.WindowType.DESKTOP)
            .map(actor => ({actor, frame: actor.meta_window.get_frame_rect()}));

        for (const layer of this._layers) {
            if (layer.mapped)
                layer.updateWindows(windows);
        }
    }

    // Restarted whenever the settings change, to pick up a new frame rate or
    // speed
    _startTimer() {
        this._stopTimer();

        this._lastTime = GLib.get_monotonic_time();
        this._lastCoverCheck = 0;
        this._speed = this._settings.get_double('speed');

        const interval = Math.round(1000 / this._settings.get_int('frame-rate'));
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval,
            () => this._tick());
    }

    _stopTimer() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    // Advances the phases by the time since the last tick rather than by a
    // fixed step, so the water moves at the same speed at any frame rate
    _tick() {
        const now = GLib.get_monotonic_time();
        const step = Math.min((now - this._lastTime) / GLib.USEC_PER_SEC, MAX_STEP);
        this._lastTime = now;

        this._phases = this._phases.map(
            (phase, i) => (phase + PHASE_RATES[i] * this._speed * step) % (2 * Math.PI));

        if (now - this._lastCoverCheck >= COVER_CHECK_INTERVAL)
            this._checkCovered();

        for (const layer of this._layers) {
            // Hidden in the overview, on the lock screen and when covered
            if (!layer.mapped)
                continue;

            layer.waterEffect.setPhases(this._phases);
            layer.waterEffect.queue_repaint();
        }

        return GLib.SOURCE_CONTINUE;
    }

    // Hides the water on monitors where a window covers all of it, which
    // also lets a fullscreen game skip compositing
    _checkCovered() {
        this._lastCoverCheck = GLib.get_monotonic_time();
        for (const layer of this._layers)
            layer.visible = !this._isCovered(layer.monitorIndex, layer.band);
    }

    /**
     * @param {number} monitorIndex - the layer's monitor
     * @param {object|null} band - stage rect of the water, or null before the
     *   layer is placed
     * @returns {boolean} whether nothing of the water can be seen
     */
    _isCovered(monitorIndex, band) {
        if (!band)
            return true;

        if (global.display.get_monitor_in_fullscreen(monitorIndex))
            return true;

        // Only an opaque window on this workspace that spans the whole band
        // hides it
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().some(windowActor => {
            const window = windowActor.meta_window;
            if (!windowActor.visible || windowActor.opacity < 255 ||
                window.minimized || !window.located_on_workspace(workspace) ||
                window.get_window_type() === Meta.WindowType.DESKTOP)
                return false;

            const rect = window.get_frame_rect();
            return rect.x <= band.x && rect.y <= band.y &&
                rect.x + rect.width >= band.x + band.width &&
                rect.y + rect.height >= band.y + band.height;
        });
    }
}
