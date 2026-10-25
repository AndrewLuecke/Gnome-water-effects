import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WaterLayer} from './waterLayer.js';

// E16 advanced its phases by these amounts on every 66 ms tick
const E16_TICK = 0.066;
const PHASE_RATES = [0.40 / E16_TICK, 0.32 / E16_TICK, 0.32 / E16_TICK];

// How far the waves swell, and how far the ripples and swell together move
// the reflection, in pixels for a 64 px band
const SWELL = 10;
const REACH = 7 + SWELL;

// Longest step the animation takes, so it doesn't lurch after a stall
const MAX_STEP = 0.25; // s

const COVER_CHECK_INTERVAL = 500 * 1000; // µs

export default class WaterEffectsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._phases = [0, 0, 0];
        this._layers = [];

        this._group = new Clutter.Actor({name: 'water-effects'});
        Main.uiGroup.insert_child_above(this._group, global.window_group);
        // Hidden with the windows in the overview and on the lock screen
        this._visibleBinding = global.window_group.bind_property('visible',
            this._group, 'visible', GObject.BindingFlags.SYNC_CREATE);

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

    _updateLayers() {
        const depth = this._settings.get_int('water-height');
        const amplitude = this._settings.get_double('amplitude');
        const waves = this._settings.get_string('effect') === 'waves';
        const scale = amplitude * depth / 64;
        const swell = waves ? Math.ceil(SWELL * scale) : 0;
        const margin = Math.ceil(REACH * scale) + 2;

        for (const layer of this._layers) {
            const monitor = Main.layoutManager.monitors[layer.monitorIndex];

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

        const windows = global.get_window_actors()
            .filter(actor => actor.is_mapped() && actor.opacity > 0 &&
                actor.meta_window.get_window_type() !== Meta.WindowType.DESKTOP)
            .map(actor => ({actor, frame: actor.meta_window.get_frame_rect()}));

        for (const layer of this._layers) {
            if (layer.mapped)
                layer.updateWindows(windows);
        }
    }

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

    _isCovered(monitorIndex, band) {
        if (!band)
            return true;

        if (global.display.get_monitor_in_fullscreen(monitorIndex))
            return true;

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
