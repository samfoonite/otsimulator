/**
 * SCADA Water Treatment Simulation — PLC Logic Engine
 *
 * Treatment process:
 *   1. Fill tank to 90%+ (high-level sensor activates)
 *   2. Chlorine pump runs for 30 seconds
 *   3. Boiling phase runs for 10 seconds, temperature reaches 400°C
 *   4. Water is now "treated"
 *   5. Fan turns on to cool water below 50°C
 *   6. Gate opens when temp < 50°C, pumps treated water to storage
 *
 * Safety interlock triggers at 500°C — kills all processes.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const state = {
    level: 0,           // 0-100 %
    temp: 0,            // degrees C (virtual)
    filling: false,
    draining: false,
    fanOn: false,
    fanMode: 'auto',    // auto | off | hand
    gateOpen: false,
    treated: false,
    interlocked: false,
    storageLevel: 0,    // 0-100 %
    storageUntreated: 0, // volume of untreated water in storage (0-100 scale)
    storageContaminated: false,
    flushingStorage: false,
    // Treatment process phases
    phase: 'IDLE',      // IDLE | FILLING | CHLORINATING | BOILING | TREATED | COOLING | DISPENSING
    chlorineStartTime: null,   // timestamp when chlorine pumping started
    boilingStartTime: null,    // timestamp when boiling started
    chlorineComplete: false,
    boilingComplete: false,
    manualGate: false,       // manual gate override
  };

  const TICK_MS = 200;           // simulation tick
  const LEVEL_STEP = 1;          // +1 % per tick when filling
  const DRAIN_STEP = 0.5;        // −0.5 % per tick when draining
  const CHLORINE_DURATION = 30;  // seconds of chlorine pumping
  const BOILING_DURATION = 10;   // seconds of boiling
  const BOILING_TARGET_TEMP = 400; // °C reached during boiling
  const FAN_COOL_STEP = 10;      // −10 °C per tick when fan is on
  const TEMP_GATE_OPEN = 50;     // gate opens when cooled below this
  const TEMP_CRITICAL = 500;     // safety interlock threshold
  const HIGH_LEVEL = 90;         // high-level switch %
  const STORAGE_STEP = 0.4;      // storage fills while gate is open

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const dom = {
    tank:         $('tank'),
    water:        $('water'),
    tankLabel:    $('tank-label'),
    clock:        $('clock'),
    // Buttons
    btnFill:      $('btn-fill'),
    btnDrain:     $('btn-drain'),
    btnReset:     $('btn-reset'),
    // LEDs
    ledLevelLow:  $('led-level-low'),
    ledLevelHigh: $('led-level-high'),
    ledChlorine:  $('led-chlorine'),
    ledBoiling:   $('led-boiling'),
    ledTempCrit:  $('led-temp-critical'),
    ledFan:       $('led-fan'),
    ledGate:      $('led-gate'),
    ledTreated:   $('led-treated'),
    // Readouts
    valLevel:     $('val-level'),
    valTemp:      $('val-temp'),
    valFanMode:   $('val-fan-mode'),
    valState:     $('val-state'),
    // Timers
    valChlorineTimer: $('val-chlorine-timer'),
    valBoilingTimer:  $('val-boiling-timer'),
    // Alarm
    alarmBanner:  $('alarm-banner'),
    // Fan
    fanBlade:     $('fan-blade'),
    hoaStatus:    $('hoa-status'),
    btnHoaAuto:   $('btn-hoa-auto'),
    btnHoaOff:    $('btn-hoa-off'),
    btnHoaHand:   $('btn-hoa-hand'),
    // Gate
    gateDoor:     $('gate-door'),
    gateLabel:    $('gate-label'),
    gateWaterFlow:$('gate-water-flow'),
    // Storage
    storageWater: $('storage-water'),
    storageLabel: $('storage-label'),
    storageTank:  $('storage-tank'),
    storageStatus:$('storage-status'),
    btnFlush:     $('btn-flush-storage'),
    contaminationAlert: $('contamination-alert'),
    ledContaminated: $('led-contaminated'),
    // Gauge
    gaugeFill:    $('gauge-fill'),
    // Manual overrides
    btnChlorine:  $('btn-chlorine'),
    btnBoil:      $('btn-boil'),
    btnGate:      $('btn-gate'),
    manualStatus: $('manual-status'),
  };

  // ── Button listeners ───────────────────────────────────────
  dom.btnFill.addEventListener('click', () => {
    if (state.interlocked) return;
    state.filling = true;
    state.draining = false;
  });

  dom.btnDrain.addEventListener('click', () => {
    if (state.interlocked) return;
    state.draining = true;
    state.filling = false;
  });

  dom.btnReset.addEventListener('click', resetProcess);

  // HOA buttons
  [dom.btnHoaAuto, dom.btnHoaOff, dom.btnHoaHand].forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.interlocked) return;
      state.fanMode = btn.dataset.mode;
    });
  });

  // Manual override buttons
  dom.btnChlorine.addEventListener('click', () => {
    if (state.interlocked) return;
    if (state.chlorineStartTime || state.chlorineComplete || state.treated) return;
    if (state.level <= 0) return;
    state.chlorineStartTime = Date.now();
    state.filling = false;
  });

  dom.btnBoil.addEventListener('click', () => {
    if (state.interlocked) return;
    if (!state.chlorineComplete) return; // chlorine must finish first
    if (state.boilingStartTime || state.boilingComplete || state.treated) return;
    state.boilingStartTime = Date.now();
  });

  dom.btnGate.addEventListener('click', () => {
    if (state.interlocked) return;
    if (state.level <= 0) return;
    state.manualGate = !state.manualGate;
  });

  // Flush storage button
  dom.btnFlush.addEventListener('click', () => {
    if (state.interlocked) return;
    if (state.storageLevel <= 0) return;
    state.flushingStorage = true;
  });

  // ── Core simulation tick ───────────────────────────────────
  function tick() {
    if (!state.interlocked) {
      levelLoop();
      treatmentLoop();
      fanLoop();
      gateLoop();
      safetyInterlock();
    }
    updatePhase();
    render();
  }

  // ── 1. Level Loop ──────────────────────────────────────────
  function levelLoop() {
    if (state.filling && state.level < 100) {
      state.level = Math.min(100, state.level + LEVEL_STEP);
    }
    if (state.draining && state.level > 0) {
      state.level = Math.max(0, state.level - DRAIN_STEP);
    }
    if (state.level >= 100) {
      state.filling = false;
    }
    if (state.level <= 0) {
      state.draining = false;
    }
  }

  // ── 2. Treatment Loop (Chlorine → Boil → Treated) ─────────
  function treatmentLoop() {
    const now = Date.now();

    // Start chlorine phase when level reaches high mark
    if (state.level >= HIGH_LEVEL && !state.chlorineStartTime && !state.chlorineComplete && !state.treated) {
      state.chlorineStartTime = now;
      state.filling = false; // stop filling, begin treatment
    }

    // Chlorine pumping phase (30 seconds)
    if (state.chlorineStartTime && !state.chlorineComplete) {
      const elapsed = (now - state.chlorineStartTime) / 1000;
      if (elapsed >= CHLORINE_DURATION) {
        state.chlorineComplete = true;
        state.boilingStartTime = now;
      }
    }

    // Boiling phase (10 seconds, temperature ramps to 400°C)
    if (state.boilingStartTime && !state.boilingComplete) {
      const elapsed = (now - state.boilingStartTime) / 1000;
      // Ramp temperature to 400°C over the 10-second boiling period
      const progress = Math.min(elapsed / BOILING_DURATION, 1);
      state.temp = Math.round(BOILING_TARGET_TEMP * progress);

      if (elapsed >= BOILING_DURATION) {
        state.boilingComplete = true;
        state.treated = true;
        state.temp = BOILING_TARGET_TEMP; // ensure exactly 400°C
      }
    }

    // Fan cooling (only after treatment is complete)
    if (state.treated && state.fanOn && state.temp > 0) {
      state.temp = Math.max(0, state.temp - FAN_COOL_STEP);
    }
  }

  // ── Fan (HOA) Logic ────────────────────────────────────────
  function fanLoop() {
    switch (state.fanMode) {
      case 'auto':
        // In auto mode, fan turns on after water is treated to cool it down
        state.fanOn = state.treated && state.temp > 0;
        break;
      case 'hand':
        state.fanOn = true;
        break;
      case 'off':
        state.fanOn = false;
        break;
    }
  }

  // ── Gate Logic ─────────────────────────────────────────────
  function gateLoop() {
    // Gate opens when water is treated AND cooled below 50°C, or manual override
    const autoOpen = state.treated && state.temp < TEMP_GATE_OPEN;
    state.gateOpen = autoOpen || state.manualGate;

    // Transfer water from process tank to storage while gate is open
    if (state.gateOpen && state.level > 0 && state.storageLevel < 100) {
      const addedVolume = STORAGE_STEP;
      // Track untreated water entering storage (manual gate with incomplete treatment)
      if (!state.chlorineComplete || !state.boilingComplete) {
        state.storageUntreated += addedVolume;
      }
      state.storageLevel = Math.min(100, state.storageLevel + addedVolume);
      state.level = Math.max(0, state.level - DRAIN_STEP);
    }

    // Close gate when tank is empty
    if (state.level <= 0) {
      state.manualGate = false;
    }

    // Flush storage (drain)
    if (state.flushingStorage && state.storageLevel > 0) {
      const drainAmount = Math.min(DRAIN_STEP, state.storageLevel);
      const ratio = state.storageLevel > 0 ? state.storageUntreated / state.storageLevel : 0;
      state.storageLevel = Math.max(0, state.storageLevel - drainAmount);
      state.storageUntreated = state.storageLevel * ratio;
    }
    if (state.storageLevel <= 0) {
      state.flushingStorage = false;
      state.storageUntreated = 0;
      state.storageContaminated = false;
    }

    // Contamination check: if >=5% of storage is untreated water
    if (state.storageLevel > 0) {
      state.storageContaminated = (state.storageUntreated / state.storageLevel) >= 0.05;
    } else {
      state.storageContaminated = false;
    }
  }

  // ── 3. Safety Interlock ────────────────────────────────────
  function safetyInterlock() {
    if (state.temp >= TEMP_CRITICAL) {
      state.interlocked = true;
      state.filling = false;
      state.draining = false;
      state.fanOn = false;
      state.gateOpen = false;
    }
  }

  // ── Phase tracker ──────────────────────────────────────────
  function updatePhase() {
    if (state.interlocked) {
      state.phase = 'INTERLOCKED';
    } else if (state.treated && state.gateOpen) {
      state.phase = 'DISPENSING';
    } else if (state.treated && state.temp >= TEMP_GATE_OPEN) {
      state.phase = 'COOLING';
    } else if (state.treated && state.temp < TEMP_GATE_OPEN) {
      state.phase = 'DISPENSING';
    } else if (state.boilingStartTime && !state.boilingComplete) {
      state.phase = 'BOILING';
    } else if (state.chlorineStartTime && !state.chlorineComplete) {
      state.phase = 'CHLORINATING';
    } else if (state.filling) {
      state.phase = 'FILLING';
    } else if (state.draining) {
      state.phase = 'DRAINING';
    } else {
      state.phase = 'IDLE';
    }
  }

  // ── Emergency Reset ────────────────────────────────────────
  function resetProcess() {
    state.level = 0;
    state.temp = 0;
    state.filling = false;
    state.draining = false;
    state.fanOn = false;
    state.fanMode = 'auto';
    state.gateOpen = false;
    state.treated = false;
    state.interlocked = false;
    state.storageLevel = 0;
    state.storageUntreated = 0;
    state.storageContaminated = false;
    state.flushingStorage = false;
    state.phase = 'IDLE';
    state.chlorineStartTime = null;
    state.boilingStartTime = null;
    state.chlorineComplete = false;
    state.boilingComplete = false;
    state.manualGate = false;
    render();
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    const { level, temp, fanOn, fanMode, gateOpen, treated, interlocked, storageLevel, phase, storageContaminated } = state;

    // Clock
    dom.clock.textContent = new Date().toLocaleTimeString();

    // Tank water level
    dom.water.style.height = level + '%';
    dom.tankLabel.textContent = Math.round(level) + ' %';

    // Water colour based on phase
    dom.water.classList.remove('hot', 'treated', 'chlorinating');
    if (phase === 'CHLORINATING') {
      dom.water.classList.add('chlorinating');
    } else if (phase === 'BOILING') {
      dom.water.classList.add('hot');
    } else if (treated) {
      dom.water.classList.add('treated');
    }

    // Tank alarm border
    dom.tank.classList.toggle('alarm', interlocked);

    // LEDs
    setLed(dom.ledLevelLow,  level > 0 && level < HIGH_LEVEL, 'on-green');
    setLed(dom.ledLevelHigh, level >= HIGH_LEVEL, 'on-yellow');
    setLed(dom.ledChlorine,  phase === 'CHLORINATING', 'on-cyan');
    setLed(dom.ledBoiling,   phase === 'BOILING', 'on-orange');
    setLed(dom.ledTempCrit,  temp >= TEMP_CRITICAL || interlocked, 'on-red');
    setLed(dom.ledFan,       fanOn, 'on-green');
    setLed(dom.ledGate,      gateOpen, 'on-green');
    setLed(dom.ledTreated,   treated, 'on-blue');
    setLed(dom.ledContaminated, storageContaminated, 'on-red');

    // Readouts
    dom.valLevel.textContent = Math.round(level) + ' %';
    dom.valTemp.innerHTML = Math.round(temp) + ' &deg;C';
    dom.valFanMode.textContent = fanMode.toUpperCase();

    // Temp readout colour
    dom.valTemp.className = 'readout-value';
    if (temp >= TEMP_CRITICAL) dom.valTemp.classList.add('critical');
    else if (temp >= 200) dom.valTemp.classList.add('warn');

    // Chlorine timer
    if (state.chlorineStartTime && !state.chlorineComplete) {
      const elapsed = (Date.now() - state.chlorineStartTime) / 1000;
      const remaining = Math.max(0, CHLORINE_DURATION - elapsed);
      dom.valChlorineTimer.textContent = Math.ceil(remaining) + 's';
      dom.valChlorineTimer.classList.add('active-timer');
    } else if (state.chlorineComplete) {
      dom.valChlorineTimer.textContent = 'DONE';
      dom.valChlorineTimer.classList.remove('active-timer');
      dom.valChlorineTimer.classList.add('done-timer');
    } else {
      dom.valChlorineTimer.textContent = '--';
      dom.valChlorineTimer.classList.remove('active-timer', 'done-timer');
    }

    // Boiling timer
    if (state.boilingStartTime && !state.boilingComplete) {
      const elapsed = (Date.now() - state.boilingStartTime) / 1000;
      const remaining = Math.max(0, BOILING_DURATION - elapsed);
      dom.valBoilingTimer.textContent = Math.ceil(remaining) + 's';
      dom.valBoilingTimer.classList.add('active-timer');
    } else if (state.boilingComplete) {
      dom.valBoilingTimer.textContent = 'DONE';
      dom.valBoilingTimer.classList.remove('active-timer');
      dom.valBoilingTimer.classList.add('done-timer');
    } else {
      dom.valBoilingTimer.textContent = '--';
      dom.valBoilingTimer.classList.remove('active-timer', 'done-timer');
    }

    // Process state
    dom.valState.textContent = phase;
    dom.valState.className = 'readout-value';
    if (interlocked) dom.valState.classList.add('critical');
    else if (phase === 'BOILING') dom.valState.classList.add('warn');
    else if (phase === 'CHLORINATING') dom.valState.classList.add('chlorine-text');

    // Alarm banner
    dom.alarmBanner.classList.toggle('hidden', !interlocked);

    // HOA button highlight
    [dom.btnHoaAuto, dom.btnHoaOff, dom.btnHoaHand].forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === fanMode);
    });
    const modeLabels = {
      auto: 'Mode: AUTO — Fan activates after treatment',
      off:  'Mode: OFF — Fan disabled',
      hand: 'Mode: HAND — Fan forced ON',
    };
    dom.hoaStatus.textContent = modeLabels[fanMode];

    // Fan blade spin
    dom.fanBlade.classList.toggle('spinning', fanOn);

    // Gate animation
    dom.gateDoor.classList.toggle('open', gateOpen);
    dom.gateLabel.textContent = gateOpen ? 'OPEN' : 'CLOSED';
    dom.gateLabel.classList.toggle('open-text', gateOpen);
    dom.gateWaterFlow.classList.toggle('hidden', !gateOpen);

    // Storage
    dom.storageWater.style.width = storageLevel + '%';
    dom.storageLabel.textContent = Math.round(storageLevel) + ' %';
    dom.storageTank.classList.toggle('contaminated', storageContaminated);
    dom.storageWater.classList.toggle('contaminated', storageContaminated);
    dom.contaminationAlert.classList.toggle('hidden', !storageContaminated);
    dom.btnFlush.disabled = interlocked || storageLevel <= 0;

    // Temperature gauge
    const gaugeMax = TEMP_CRITICAL; // 500°C = full gauge
    const gaugeRatio = Math.min(temp / gaugeMax, 1);
    const arcLength = 157; // approximate arc length of the semicircle
    const dashOffset = arcLength * (1 - gaugeRatio);
    dom.gaugeFill.style.strokeDashoffset = dashOffset;
    if (temp >= TEMP_CRITICAL) {
      dom.gaugeFill.style.stroke = 'var(--red)';
    } else if (temp >= 200) {
      dom.gaugeFill.style.stroke = 'var(--yellow)';
    } else {
      dom.gaugeFill.style.stroke = 'var(--green)';
    }

    // Disable controls during interlock (except reset)
    dom.btnFill.disabled = interlocked;
    dom.btnDrain.disabled = interlocked;
    dom.btnHoaAuto.disabled = interlocked;
    dom.btnHoaOff.disabled = interlocked;
    dom.btnHoaHand.disabled = interlocked;

    // Manual override buttons
    dom.btnChlorine.disabled = interlocked || !!state.chlorineStartTime || state.chlorineComplete || treated || level <= 0;
    dom.btnBoil.disabled = interlocked || !state.chlorineComplete || !!state.boilingStartTime || state.boilingComplete || treated;
    dom.btnGate.disabled = interlocked || level <= 0;

    dom.btnChlorine.classList.toggle('active', phase === 'CHLORINATING');
    dom.btnBoil.classList.toggle('active', phase === 'BOILING');
    dom.btnGate.classList.toggle('active', state.manualGate);

    // Manual status text
    if (interlocked) {
      dom.manualStatus.textContent = 'Manual control: disabled during interlock';
    } else if (phase === 'DISPENSING') {
      dom.manualStatus.textContent = 'Dispensing treated water to storage...';
    } else if (phase === 'CHLORINATING') {
      dom.manualStatus.textContent = 'Chlorine pump active...';
    } else if (phase === 'BOILING') {
      dom.manualStatus.textContent = 'Boiling in progress...';
    } else {
      dom.manualStatus.textContent = 'Manual control: trigger treatment phases directly';
    }
  }

  function setLed(el, on, cls) {
    el.className = 'led' + (on ? ' ' + cls : '');
  }

  // ── Start ──────────────────────────────────────────────────
  setInterval(tick, TICK_MS);
  render();
})();
