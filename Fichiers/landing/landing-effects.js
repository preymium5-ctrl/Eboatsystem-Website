const RIPPLE_COUNT = 4;
const RIPPLE_LIFETIME = 2.25;
const INTERACTIVE = 'button, a[href]';

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform sampler2D uVideo;
  uniform vec2 uCover;
  uniform vec2 uAnchor;
  uniform float uAspect;
  uniform float uTime;
  uniform vec4 uRipples[${RIPPLE_COUNT}];
  uniform float uOceanMask;
  uniform float uWaterline;
  uniform vec2 uSourceSize;
  uniform vec4 uBoatMask;
  uniform vec2 uDockMask[4];
  varying vec2 vUv;

  float cross2(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
  }

  float boatProtection(vec2 p) {
    // Distances are source-image pixels, so portrait/landscape feather equally.
    vec2 inset = min(p - uBoatMask.xy, uBoatMask.zw - p) * uSourceSize;
    float inside = min(inset.x, inset.y);
    // An eight-pixel guard prevents a nearby water sample pulling a hull edge.
    return smoothstep(-4.0, 4.0, inside + 8.0);
  }

  float dockProtection(vec2 p) {
    vec2 point = p * uSourceSize;
    float inside = 100000.0;
    for (int i = 0; i < 4; i++) {
      vec2 a = uDockMask[i] * uSourceSize;
      // Constant array indexing keeps this compatible with WebGL 1 drivers.
      vec2 b;
      if (i == 0) b = uDockMask[1] * uSourceSize;
      else if (i == 1) b = uDockMask[2] * uSourceSize;
      else if (i == 2) b = uDockMask[3] * uSourceSize;
      else b = uDockMask[0] * uSourceSize;
      vec2 edge = b - a;
      inside = min(inside, cross2(edge, point - a) / max(length(edge), 0.001));
    }
    return smoothstep(-4.0, 4.0, inside + 8.0);
  }

  void main() {
    // Video, poster and ripple layer share one compositor camera. The native
    // video supplies the background; this transparent layer draws only wakes.
    vec2 projected = vUv;
    vec2 sourceUv = (projected - 0.5) * uCover + 0.5 + (uAnchor - 0.5) * (1.0 - uCover);
    // Mask in the original image, not the viewport: it follows crop and camera.
    vec2 sourcePoint = vec2(sourceUv.x, 1.0 - sourceUv.y);
    float protectedProduct = max(boatProtection(sourcePoint), dockProtection(sourcePoint));
    float oceanWater = smoothstep(uWaterline - 0.012, uWaterline + 0.035, sourcePoint.y) * (1.0 - protectedProduct);
    vec2 point = vec2(vUv.x * uAspect, vUv.y);
    vec2 displacement = vec2(0.0);
    float light = 0.0;
    float coverage = 0.0;
    // The architecture stays composed; the water carries the larger wake.
    float water = mix(0.14, 1.0, smoothstep(0.48, 0.76, 1.0 - vUv.y));
    water = mix(water, oceanWater, uOceanMask);
    for (int i = 0; i < ${RIPPLE_COUNT}; i++) {
      vec4 ripple = uRipples[i];
      float age = uTime - ripple.z;
      if (age >= 0.0 && age < 2.25 && ripple.w > 0.0) {
        vec2 delta = point - vec2(ripple.x * uAspect, ripple.y);
        float distance = length(delta);
        float radius = age * 0.21;
        float width = 0.034 + age * 0.014;
        float band = exp(-pow((distance - radius) / width, 2.0));
        float fade = exp(-age * 1.8) * (1.0 - smoothstep(1.6, 2.25, age));
        float wave = sin((distance - radius) * 105.0) * band * fade * ripple.w;
        displacement += delta / max(distance, 0.001) * wave * 0.0034 * water;
        light += wave * 0.0035 * water;
        coverage += band * fade * ripple.w;
      }
    }
    float edge = min(min(projected.x, 1.0 - projected.x), min(projected.y, 1.0 - projected.y));
    vec2 shift = vec2(displacement.x / uAspect, displacement.y) * smoothstep(0.0, 0.05, edge);
    float opacity = clamp(coverage * 1.8, 0.0, 1.0) * water;
    if (opacity < 0.002) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec2 uv = sourceUv + shift * uCover;
    vec3 color = texture2D(uVideo, clamp(uv, 0.001, 0.999)).rgb;
    gl_FragColor = vec4(color + light, opacity);
  }
`;

/** Pointer effects are an enhancement of the existing video, never its owner. */
export function setupLandingEffects({landing, video, menu, reducedMotion}) {
  const media = landing?.querySelector('.landing-media');
  const cursor = landing?.querySelector('.landing-cursor');
  if (!landing || !video || !media) return {destroy() {}, refresh() {}};

  const motionPreference = reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width:761px)');
  const finePointer = matchMedia('(any-pointer:fine)');
  const oceanScene = landing.classList.contains('landing-ocean');
  const canvas = document.createElement('canvas');
  canvas.className = 'landing-refraction';
  canvas.setAttribute('aria-hidden', 'true');
  media.append(canvas);

  const startedAt = performance.now();
  const cleanups = [];
  const ripples = Array.from({length:RIPPLE_COUNT}, () => ({x:0, y:0, time:-100, strength:0}));
  const rippleUniforms = new Float32Array(RIPPLE_COUNT * 4);
  const boatMask = new Float32Array(4);
  const dockMask = new Float32Array(8);
  const videoAnchor = new Float32Array(2);
  const productBounds = new Float32Array(4);
  let waterline = 0.36;
  const magnets = new Map();
  const view = {x:0, y:0, vx:0, vy:0, targetX:0, targetY:0, lastX:0, lastY:0};
  const pointer = {x:0, y:0, targetX:0, targetY:0, vx:0, vy:0, scale:1, targetScale:1};
  let destroyed = false;
  let visible = true;
  let mouseSeen = false;
  let touchInput = false;
  let pointerInside = false;
  let pointerInitialized = false;
  let activeMagnet = null;
  let rippleIndex = 0;
  let previousEvent = null;
  let lastRippleAt = -1000;
  let lastRippleX = 0;
  let lastRippleY = 0;
  let animationFrame = 0;
  let videoFrame = 0;
  let previousFrameAt = 0;
  let framePending = true;
  let uploadedTime = -1;
  let textureReady = false;
  let textureWidth = 0;
  let textureHeight = 0;
  let rippleFrames = 0;
  let contextLost = false;
  let graphicsFailed = false;
  let gl = null;
  let resources = null;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let cameraBaseScale = 1.10;
  let menuWasOpen = false;

  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    cleanups.push(() => target.removeEventListener(event, callback, options));
  }

  function nowSeconds(now = performance.now()) {
    return (now - startedAt) / 1000;
  }

  function enabled() {
    // A narrow desktop pane still has a mouse. Width only chooses composition.
    return !destroyed && !motionPreference.matches && !touchInput && (mouseSeen || finePointer.matches);
  }

  function onScreen() {
    return enabled() && visible && !document.hidden;
  }

  function interactionAllowed() {
    return onScreen() && !menu?.open;
  }

  function hasRipples(now = performance.now()) {
    const time = nowSeconds(now);
    return ripples.some(ripple => ripple.strength > 0 && time - ripple.time < RIPPLE_LIFETIME);
  }

  function wantsRefraction() {
    return interactionAllowed() && hasRipples() && !graphicsFailed && !contextLost;
  }

  function showCanvas(show) {
    canvas.classList.toggle('is-ready', show);
    if (landing.dataset.refractionReady !== String(show)) landing.dataset.refractionReady = String(show);
    landing.dataset.renderMode = show ? 'ripple-overlay' : 'native-video';
  }

  function hidePointer() {
    pointerInside = false;
    landing.classList.remove('landing-pointer-active');
    pointer.targetScale = 1;
    if (activeMagnet) {
      activeMagnet.targetX = 0;
      activeMagnet.targetY = 0;
      activeMagnet = null;
    }
  }

  function cancelVideoFrame() {
    if (videoFrame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrame);
    videoFrame = 0;
  }

  function requestVideoFrame() {
    if (!video.requestVideoFrameCallback || videoFrame || video.paused || !wantsRefraction()) return;
    videoFrame = video.requestVideoFrameCallback(now => {
      videoFrame = 0;
      if (!wantsRefraction()) return;
      framePending = true;
      // Avoid queuing another v-sync when a decoded frame can be drawn now.
      if (!animationFrame) drawRefraction(now);
      requestVideoFrame();
    });
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      throw new Error('Landing shader could not compile');
    }
    return shader;
  }

  function updateOceanMask() {
    const variant = sourceVariant();
    landing.dataset.waterMask = oceanScene ? variant : 'off';
    const defaults = variant === 'desktop'
      ? {boat:[0.56,0.52,0.91,0.93],dock:[0.84,0.80, 1,0.80, 1,1, 0.84,1]}
      : {boat:[0.10,0.52,0.94,0.92],dock:[0.79,0.78, 1,0.78, 1,1, 0.79,1]};
    function coordinates(name, fallback) {
      const raw = video.getAttribute(`data-${variant}-${name}`);
      const values = raw?.trim().split(/[\s,]+/).map(Number);
      return values?.length === fallback.length && values.every(value=>Number.isFinite(value) && value >= 0 && value <= 1)
        ? values : fallback;
    }
    videoAnchor.set(coordinates('anchor',variant === 'desktop' ? [0.5,0.5] : [0.8,0.5]));
    landing.dataset.cameraAnchor = [...videoAnchor].map(value=>Number(value.toFixed(4))).join(',');
    const boat = coordinates('boat-mask',defaults.boat);
    boatMask.set(boat[2] > boat[0] && boat[3] > boat[1] ? boat : defaults.boat);
    const product = coordinates('product-bounds',defaults.boat);
    productBounds.set(product[2] > product[0] && product[3] > product[1] ? product : defaults.boat);
    landing.dataset.productBounds = [...productBounds].map(value=>Number(value.toFixed(4))).join(',');
    const dock = coordinates('dock-mask',defaults.dock);
    // A convex quad must wind clockwise when expressed with a top-left origin.
    let validDock = true;
    for (let index=0;index<4;index++) {
      const next = (index+1)%4, after = (index+2)%4;
      const ax = dock[next*2]-dock[index*2], ay = dock[next*2+1]-dock[index*2+1];
      const bx = dock[after*2]-dock[next*2], by = dock[after*2+1]-dock[next*2+1];
      if (ax*by-ay*bx <= 0.000001) validDock = false;
    }
    dockMask.set(validDock ? dock : defaults.dock);
    const configuredWaterline = Number(video.getAttribute(`data-${variant}-waterline`) ?? 0.36);
    waterline = Number.isFinite(configuredWaterline) && configuredWaterline >= 0 && configuredWaterline <= 1 ? configuredWaterline : 0.36;
  }

  function sourceVariant() {
    const selected = landing.dataset.mediaVariant;
    return selected === 'desktop' || selected === 'portrait' ? selected : desktop.matches ? 'desktop' : 'portrait';
  }

  function cameraParameters(x, y) {
    const aspect = viewportWidth / viewportHeight;
    const wideCorrection = Math.max(0,aspect-2.1)*0.045;
    return {
      aspect,
      scale:cameraBaseScale+((desktop.matches ? 0.14 : 0.10)+wideCorrection)*Math.max(Math.abs(x),Math.abs(y)),
      travelX:-x*(desktop.matches ? 0.06 : 0.04),
      travelY:-y*(desktop.matches ? 0.038 : 0.03),
      yaw:x*(desktop.matches ? 6 : 4)*Math.PI/180,
      pitch:y*(desktop.matches ? 2.7 : 2.1)*Math.PI/180,
    };
  }

  function menuShiftRange() {
    // Check both ends of the drawer's lateral move, including its CSS transition.
    if (!menu?.open) return [0,0];
    const raw = getComputedStyle(landing).getPropertyValue('--landing-menu-shift-x').trim();
    const amount = parseFloat(raw) || 0;
    const shift = raw.endsWith('vw') ? amount*innerWidth/100/viewportWidth
      : raw.endsWith('%') ? amount/100 : amount/viewportWidth;
    const openShift = desktop.matches && menu?.open ? -innerWidth*0.01/viewportWidth : 0;
    return [Math.min(0,shift,openShift),Math.max(0,shift,openShift)];
  }

  function productFits(x, y, shifts) {
    const pose = cameraParameters(x,y);
    const sourceAspect = video.videoWidth && video.videoHeight
      ? video.videoWidth/video.videoHeight : sourceVariant() === 'desktop' ? 16/9 : 9/16;
    const coverX = pose.aspect > sourceAspect ? 1 : pose.aspect/sourceAspect;
    const coverY = pose.aspect > sourceAspect ? sourceAspect/pose.aspect : 1;
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
    const cx = Math.cos(pose.pitch), sx = Math.sin(pose.pitch);
    const margin = 0.015;
    for (let corner=0;corner<4;corner++) {
      const u = productBounds[corner === 0 || corner === 3 ? 0 : 2];
      const v = 1-productBounds[corner < 2 ? 1 : 3];
      const baseX = (u-0.5-(videoAnchor[0]-0.5)*(1-coverX))/coverX+0.5;
      const baseY = (v-0.5-(0.5-videoAnchor[1])*(1-coverY))/coverY+0.5;
      const localX = (baseX-0.5)*2*pose.aspect;
      const localY = (baseY-0.5)*2;
      const hitX = cy*localX;
      const hitY = sx*sy*localX+cx*localY;
      const hitZ = -cx*sy*localX+sx*localY;
      const perspective = 3.4/(3.4-hitZ);
      const screenX = hitX*perspective/(2*pose.aspect)*pose.scale+0.5+pose.travelX;
      const screenY = -hitY*perspective/2*pose.scale+0.5+pose.travelY;
      if (!Number.isFinite(screenX+screenY) || screenX+shifts[0] < margin ||
          screenX+shifts[1] > 1-margin || screenY < margin || screenY > 1-margin) return false;
    }
    return true;
  }

  function fittedHeading(x, y) {
    if (!oceanScene) return {x,y,ratio:1,status:'off'};
    const shifts = menuShiftRange();
    if (productFits(x,y,shifts)) return {x,y,ratio:1,status:'free'};
    // If intrinsic cover already crops the product, avoid amplifying that crop.
    if (!productFits(0,0,shifts)) return {x:0,y:0,ratio:0,status:'neutral-crop'};
    let low = 0, high = 1;
    for (let iteration=0;iteration<15;iteration++) {
      const middle = (low+high)/2;
      if (productFits(x*middle,y*middle,shifts)) low = middle;
      else high = middle;
    }
    return {x:x*low,y:y*low,ratio:low,status:'limited'};
  }

  function adaptCameraBaseScale() {
    cameraBaseScale = 1.10;
    // A tall source inside a short desktop pane can need less neutral overscan.
    // Keep enough breathing room for its mouse interaction rather than locking it.
    if (oceanScene && sourceVariant() === 'portrait' && !productFits(0,0,[0,0])) {
      cameraBaseScale = 1.025;
      if (productFits(0,0,[0,0])) {
        let low = 1.025, high = 1.10;
        for (let iteration=0;iteration<12;iteration++) {
          cameraBaseScale = (low+high)/2;
          if (productFits(0,0,[0,0])) low = cameraBaseScale;
          else high = cameraBaseScale;
        }
        cameraBaseScale = Math.max(1.025,low-0.015);
      }
    }
    landing.dataset.cameraBaseScale = cameraBaseScale.toFixed(4);
  }

  function setViewTarget(x, y) {
    const fit = fittedHeading(x,y);
    view.targetX = fit.x;
    view.targetY = fit.y;
    landing.dataset.cameraFit = fit.ratio.toFixed(4);
    landing.dataset.productFit = fit.status;
  }

  function releaseGraphics() {
    if (!gl || !resources || contextLost) {
      resources = null;
      return;
    }
    gl.deleteBuffer(resources.buffer);
    gl.deleteTexture(resources.texture);
    gl.deleteProgram(resources.program);
    resources = null;
  }

  function initializeGraphics() {
    if (resources) return true;
    if (graphicsFailed || contextLost) return false;
    try {
      gl = canvas.getContext('webgl', {
        alpha:true, antialias:false, depth:false, stencil:false,
        premultipliedAlpha:false, preserveDrawingBuffer:false, powerPreference:'low-power',
      });
      if (!gl) throw new Error('WebGL is unavailable');
      const vertex = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragment = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        throw new Error('Landing shader could not link');
      }
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.disable(gl.DEPTH_TEST);
      resources = {
        program, buffer, texture,
        position:gl.getAttribLocation(program, 'aPosition'),
        cover:gl.getUniformLocation(program, 'uCover'),
        anchor:gl.getUniformLocation(program, 'uAnchor'),
        aspect:gl.getUniformLocation(program, 'uAspect'),
        time:gl.getUniformLocation(program, 'uTime'),
        ripples:gl.getUniformLocation(program, 'uRipples[0]'),
        oceanMask:gl.getUniformLocation(program, 'uOceanMask'),
        waterline:gl.getUniformLocation(program, 'uWaterline'),
        sourceSize:gl.getUniformLocation(program, 'uSourceSize'),
        boatMask:gl.getUniformLocation(program, 'uBoatMask'),
        dockMask:gl.getUniformLocation(program, 'uDockMask[0]'),
        video:gl.getUniformLocation(program, 'uVideo'),
      };
      landing.dataset.refractionState = 'ready';
      textureReady = false;
      textureWidth = textureHeight = 0;
      framePending = true;
      resizeCanvas();
      return true;
    } catch {
      releaseGraphics();
      graphicsFailed = true;
      landing.dataset.refractionState = 'fallback';
      showCanvas(false);
      return false;
    }
  }

  function resizeCanvas() {
    viewportWidth = Math.max(1, media.clientWidth);
    viewportHeight = Math.max(1, media.clientHeight);
    media.style.setProperty('--landing-projection-distance',`${viewportHeight*1.7}px`);
    updateOceanMask();
    adaptCameraBaseScale();
    // Keep a fullscreen effect bounded even on large, high-density monitors.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25, 2400 / Math.max(viewportWidth, viewportHeight));
    const width = Math.max(1, Math.round(viewportWidth * dpr));
    const height = Math.max(1, Math.round(viewportHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (gl && !contextLost) gl.viewport(0, 0, width, height);
  }

  function drawRefraction(now) {
    if (!wantsRefraction(now)) {
      showCanvas(false);
      cancelVideoFrame();
      if (!contextLost && !graphicsFailed) landing.dataset.refractionState = 'native';
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      showCanvas(false);
      landing.dataset.refractionState = 'waiting-media';
      return;
    }
    if (!initializeGraphics()) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.texture);
    // Upload decoded frames, not every pointer animation frame.
    const fallbackFrame = !video.requestVideoFrameCallback && video.currentTime !== uploadedTime;
    if (framePending || !textureReady || fallbackFrame) {
      try {
        // Keep storage alive between frames; RGB video uploads can require an
        // extra conversion on WebGL drivers. Upload before selecting our shader.
        if (textureWidth !== video.videoWidth || textureHeight !== video.videoHeight) {
          textureWidth = video.videoWidth;
          textureHeight = video.videoHeight;
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,textureWidth,textureHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        }
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,video);
        if (!textureReady && gl.getError() !== gl.NO_ERROR) throw new Error('Video texture is unavailable');
        uploadedTime = video.currentTime;
        framePending = false;
        textureReady = true;
      } catch {
        showCanvas(false);
        graphicsFailed = true;
        landing.dataset.refractionState = 'fallback';
        cancelVideoFrame();
        return;
      }
    }
    if (!textureReady) return;
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
    gl.enableVertexAttribArray(resources.position);
    gl.vertexAttribPointer(resources.position, 2, gl.FLOAT, false, 0, 0);

    const viewportAspect = viewportWidth / viewportHeight;
    const sourceAspect = video.videoWidth / video.videoHeight;
    const coverX = viewportAspect > sourceAspect ? 1 : viewportAspect / sourceAspect;
    const coverY = viewportAspect > sourceAspect ? sourceAspect / viewportAspect : 1;
    ripples.forEach((ripple, index) => {
      const offset = index * 4;
      rippleUniforms[offset] = ripple.x;
      rippleUniforms[offset + 1] = ripple.y;
      rippleUniforms[offset + 2] = ripple.time;
      rippleUniforms[offset + 3] = ripple.strength;
    });
    gl.uniform1i(resources.video, 0);
    gl.uniform2f(resources.cover, coverX, coverY);
    // Attributes follow CSS object-position. Texture V runs from bottom to top.
    gl.uniform2f(resources.anchor, videoAnchor[0], 1-videoAnchor[1]);
    gl.uniform1f(resources.aspect, viewportAspect);
    gl.uniform1f(resources.time, nowSeconds(now));
    gl.uniform4fv(resources.ripples, rippleUniforms);
    gl.uniform1f(resources.oceanMask, oceanScene ? 1 : 0);
    gl.uniform1f(resources.waterline, waterline);
    gl.uniform2f(resources.sourceSize, video.videoWidth, video.videoHeight);
    gl.uniform4fv(resources.boatMask, boatMask);
    gl.uniform2fv(resources.dockMask, dockMask);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    landing.dataset.rippleFrames = String(++rippleFrames);
    // The source video remains underneath, including until this first valid draw.
    showCanvas(true);
    landing.dataset.refractionState = menu?.open ? 'menu-camera' : 'active';
    requestVideoFrame();
  }

  function updatePointer(now) {
    const dt = Math.min(0.033, Math.max(0.001, (now - (previousFrameAt || now - 16.7)) / 1000));
    previousFrameAt = now;
    const viewEase = 1 - Math.exp(-dt / (menu?.open ? 0.42 : 0.24));
    // The camera rides a critically damped spring instead of plain easing: it gathers
    // speed gently, glides, and settles without a jolt (about 0.45 s to rest).
    const omega = menu?.open ? 7 : 10;
    view.vx += ((view.targetX - view.x) * omega * omega - view.vx * 2 * omega) * dt;
    view.vy += ((view.targetY - view.y) * omega * omega - view.vy * 2 * omega) * dt;
    view.x += view.vx * dt;
    view.y += view.vy * dt;
    if (oceanScene) {
      // Safe target poses can have an unsafe interpolated pose between them.
      // Project that transient back toward neutral before drawing either layer.
      const safe = fittedHeading(view.x,view.y);
      // If the pose was pulled back to a safe crop, drop the spring's push past it.
      if (Math.abs(safe.x - view.x) > 1e-5) view.vx *= 0.5;
      if (Math.abs(safe.y - view.y) > 1e-5) view.vy *= 0.5;
      view.x = safe.x;
      view.y = safe.y;
      landing.dataset.productSafe = String(safe.status !== 'neutral-crop');
    }
    if (Math.abs(view.x) < 0.00005 && Math.abs(view.vx) < 0.0005) view.x = 0;
    if (Math.abs(view.y) < 0.00005 && Math.abs(view.vy) < 0.0005) view.y = 0;
    const travelX = -view.x * viewportWidth * (desktop.matches ? 0.06 : 0.04);
    const travelY = -view.y * viewportHeight * (desktop.matches ? 0.038 : 0.03);
    // Zoom only as far as the orbit requires. A quiet centered view preserves
    // more of the original arches than a permanently enlarged source plane.
    const overscan = cameraParameters(view.x,view.y).scale;
    landing.style.setProperty('--landing-view-x', `${travelX.toFixed(3)}px`);
    landing.style.setProperty('--landing-view-y', `${travelY.toFixed(3)}px`);
    landing.style.setProperty('--landing-view-yaw', `${(view.x * (desktop.matches ? 6 : 4)).toFixed(3)}deg`);
    landing.style.setProperty('--landing-view-pitch', `${(view.y * (desktop.matches ? 2.7 : 2.1)).toFixed(3)}deg`);
    landing.style.setProperty('--landing-camera-scale', overscan.toFixed(5));
    landing.style.setProperty('--landing-copy-x', `${(travelX * 0.55).toFixed(3)}px`);
    landing.style.setProperty('--landing-copy-y', `${(travelY * 0.65).toFixed(3)}px`);
    landing.style.setProperty('--landing-copy-yaw', `${(view.x * 2.5).toFixed(3)}deg`);
    landing.style.setProperty('--landing-copy-pitch', `${(view.y * 1.2).toFixed(3)}deg`);

    // Fast follow: the ring closes ~90% of the gap in a tenth of a second, so it stays
    // glued to the pointer with only a hair of trail and no wobble.
    const follow = 1 - Math.exp(-dt / 0.045);
    const nextX = pointer.x + (pointer.targetX - pointer.x) * follow;
    const nextY = pointer.y + (pointer.targetY - pointer.y) * follow;
    pointer.vx = (nextX - pointer.x) / dt;
    pointer.vy = (nextY - pointer.y) / dt;
    pointer.x = nextX;
    pointer.y = nextY;
    pointer.scale += (pointer.targetScale - pointer.scale) * (1 - Math.exp(-dt / 0.08));
    landing.style.setProperty('--landing-cursor-x', `${pointer.x.toFixed(2)}px`);
    landing.style.setProperty('--landing-cursor-y', `${pointer.y.toFixed(2)}px`);
    landing.style.setProperty('--landing-cursor-scale', pointer.scale.toFixed(3));

    let movingMagnet = false;
    magnets.forEach((magnet, element) => {
      magnet.x += (magnet.targetX - magnet.x) * viewEase;
      magnet.y += (magnet.targetY - magnet.y) * viewEase;
      element.style.setProperty('--landing-magnet-x', `${magnet.x.toFixed(2)}px`);
      element.style.setProperty('--landing-magnet-y', `${magnet.y.toFixed(2)}px`);
      if (Math.abs(magnet.targetX - magnet.x) + Math.abs(magnet.targetY - magnet.y) > 0.03) movingMagnet = true;
    });
    return movingMagnet || Math.abs(view.targetX - view.x) + Math.abs(view.targetY - view.y) > 0.0002 ||
      Math.abs(view.vx) + Math.abs(view.vy) > 0.001 ||
      (pointerInside && (Math.hypot(pointer.targetX - pointer.x, pointer.targetY - pointer.y) > 0.08 ||
      Math.abs(pointer.targetScale - pointer.scale) > 0.005));
  }

  function tick(now) {
    animationFrame = 0;
    if (!onScreen()) return;
    if (menu?.open) hidePointer();
    const moving = updatePointer(now);
    drawRefraction(now);
    // The compositor keeps the video and its camera live without a WebGL copy.
    // Only pointer motion and active wakes need an animation callback.
    const needsVideoFallback = wantsRefraction() && !video.requestVideoFrameCallback && !video.paused;
    if (moving || hasRipples(now) || needsVideoFallback) animationFrame = requestAnimationFrame(tick);
    else previousFrameAt = 0;
  }

  function wake() {
    if (!animationFrame && onScreen()) animationFrame = requestAnimationFrame(tick);
  }

  function spawnRipple(event, strength = 1) {
    const now = performance.now();
    const distance = Math.hypot(event.clientX - lastRippleX, event.clientY - lastRippleY);
    if (strength <= 1 && (now - lastRippleAt < 110 || distance < 48)) return;
    const rect = media.getBoundingClientRect();
    const ripple = ripples[rippleIndex];
    const screenX = ((event.clientX-rect.left)/rect.width-0.5)*2*viewportWidth/viewportHeight;
    const screenY = (0.5-(event.clientY-rect.top)/rect.height)*2;
    const {yaw,pitch,aspect} = cameraParameters(view.x,view.y);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
    const rayX = screenX/3.4, rayY = screenY/3.4;
    const rayDistance = -3.4*cx*cy/(sy*rayX-sx*cy*rayY-cx*cy);
    const hitX = rayX*rayDistance, hitY = rayY*rayDistance, hitZ = 3.4-rayDistance;
    ripple.x = Math.max(0,Math.min(1,(hitX*cy+hitY*sx*sy-hitZ*cx*sy)/(2*aspect)+0.5));
    ripple.y = Math.max(0,Math.min(1,(hitY*cx+hitZ*sx)/2+0.5));
    ripple.time = nowSeconds(now);
    ripple.strength = strength;
    rippleIndex = (rippleIndex + 1) % RIPPLE_COUNT;
    lastRippleAt = now;
    lastRippleX = event.clientX;
    lastRippleY = event.clientY;
    if (!textureReady || !canvas.classList.contains('is-ready')) framePending = true;
  }

  function movePointer(event) {
    // Actual input wins over hover media queries, including embedded browsers.
    if (event.pointerType === 'touch') {
      touchInput = true;
      mouseSeen = false;
      refresh();
      return;
    }
    if (event.pointerType !== 'mouse') return;
    const newlyEnabled = !enabled();
    mouseSeen = true;
    touchInput = false;
    if (newlyEnabled) refresh();
    if (!interactionAllowed()) return;
    pointerInside = true;
    pointer.targetX = event.clientX;
    pointer.targetY = event.clientY;
    if (!pointerInitialized) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointerInitialized = true;
    }
    landing.classList.add('landing-pointer-active');
    const rect = landing.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
    const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
    view.lastX = x;
    view.lastY = y;
    setViewTarget(x,y);

    const control = event.target.closest?.(INTERACTIVE);
    const target = control && landing.contains(control) ? control : null;
    if (activeMagnet && activeMagnet.element !== target) {
      activeMagnet.targetX = 0;
      activeMagnet.targetY = 0;
      activeMagnet = null;
    }
    pointer.targetScale = target ? 1.55 : 1;
    landing.dataset.cursorMode = target ? 'control' : 'scene';
    if (target) {
      if (!magnets.has(target)) magnets.set(target, {element:target, x:0, y:0, targetX:0, targetY:0});
      activeMagnet = magnets.get(target);
      const bounds = target.getBoundingClientRect();
      const limit = target.classList.contains('landing-circle') ? 7 : 5;
      const offsetX = event.clientX - (bounds.left + bounds.width / 2 - activeMagnet.x);
      const offsetY = event.clientY - (bounds.top + bounds.height / 2 - activeMagnet.y);
      activeMagnet.targetX = Math.max(-limit, Math.min(limit, offsetX * 0.18));
      activeMagnet.targetY = Math.max(-limit, Math.min(limit, offsetY * 0.18));
    }
    const now = performance.now();
    const distance = previousEvent ? Math.hypot(event.clientX - previousEvent.x, event.clientY - previousEvent.y) : 30;
    const elapsed = previousEvent ? Math.max(8, now - previousEvent.time) : 16;
    spawnRipple(event, Math.max(0.55, Math.min(1, distance / elapsed * 0.55)));
    previousEvent = {x:event.clientX, y:event.clientY, time:now};
    wake();
  }

  function resetScene() {
    hidePointer();
    view.x = 0;
    view.y = 0;
    view.vx = view.vy = 0;
    view.targetX = view.targetY = view.lastX = view.lastY = 0;
    ['--landing-view-x','--landing-view-y','--landing-view-yaw','--landing-view-pitch','--landing-camera-scale',
      '--landing-copy-x','--landing-copy-y','--landing-copy-yaw','--landing-copy-pitch'].forEach(property => landing.style.removeProperty(property));
    magnets.forEach((magnet, element) => {
      magnet.x = magnet.y = magnet.targetX = magnet.targetY = 0;
      element.style.removeProperty('--landing-magnet-x');
      element.style.removeProperty('--landing-magnet-y');
    });
  }

  function refresh() {
    if (destroyed) return;
    landing.dataset.pointerReady = String(enabled());
    if (!onScreen()) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      previousFrameAt = 0;
      cancelVideoFrame();
      showCanvas(false);
      resetScene();
      landing.dataset.refractionState = motionPreference.matches ? 'disabled-motion' : touchInput ? 'disabled-touch' : !enabled() ? 'waiting-pointer' : 'suspended';
      return;
    }
    resizeCanvas();
    if (menu?.open) {
      hidePointer();
      ripples.forEach(ripple => { ripple.strength = 0; });
      // Continue from the current heading, then settle toward the right view;
      // the independently animated drawer shift supplies the lateral push.
      setViewTarget(Math.max(0.82,view.lastX),view.lastY*0.45);
      menuWasOpen = true;
      landing.dataset.refractionState = 'menu-camera';
    } else if (!graphicsFailed && !contextLost) {
      if (menuWasOpen || oceanScene) {
        setViewTarget(view.lastX,view.lastY);
        menuWasOpen = false;
      }
      landing.dataset.refractionState = mouseSeen || finePointer.matches ? 'ready' : 'waiting-pointer';
    }
    framePending = true;
    wake();
  }

  function invalidateTexture() {
    cancelVideoFrame();
    textureReady = false;
    uploadedTime = -1;
    framePending = true;
    showCanvas(false);
    if (enabled() && !graphicsFailed && !contextLost) landing.dataset.refractionState = 'waiting-media';
    wake();
  }

  listen(landing, 'pointermove', movePointer, {passive:true});
  listen(landing, 'pointerleave', () => { hidePointer(); previousEvent = null; wake(); });
  listen(landing, 'pointerdown', event => {
    if (event.pointerType === 'touch') {
      touchInput = true;
      mouseSeen = false;
      refresh();
      return;
    }
    if (event.pointerType === 'mouse' && !enabled()) movePointer(event);
    if (event.pointerType !== 'mouse' || !interactionAllowed()) return;
    pointer.targetScale = 0.8;
    spawnRipple(event, 1.1);
    wake();
  }, {passive:true});
  listen(window, 'pointerup', () => { pointer.targetScale = activeMagnet ? 1.55 : 1; wake(); }, {passive:true});
  listen(document, 'visibilitychange', refresh);
  listen(window, 'blur', () => { hidePointer(); wake(); });
  listen(window, 'resize', refresh, {passive:true});
  listen(desktop, 'change', refresh);
  listen(finePointer, 'change', refresh);
  listen(motionPreference, 'change', refresh);
  listen(video, 'emptied', invalidateTexture);
  listen(video, 'resize', invalidateTexture);
  listen(video, 'loadeddata', () => { framePending = true; refresh(); });
  listen(video, 'playing', () => { framePending = true; wake(); requestVideoFrame(); });
  listen(video, 'pause', () => { cancelVideoFrame(); framePending = true; wake(); });
  listen(video, 'seeked', () => { framePending = true; wake(); });
  listen(video, 'error', () => { invalidateTexture(); landing.dataset.refractionState = 'fallback'; });
  listen(canvas, 'webglcontextlost', event => {
    event.preventDefault();
    contextLost = true;
    resources = null;
    textureReady = false;
    cancelVideoFrame();
    showCanvas(false);
    landing.dataset.refractionState = 'context-lost';
  });
  listen(canvas, 'webglcontextrestored', () => {
    contextLost = false;
    graphicsFailed = false;
    framePending = true;
    refresh();
  });

  const intersection = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting && entries[0].intersectionRatio > 0.025;
    refresh();
  }, {threshold:[0, 0.025]});
  intersection.observe(landing);
  const resize = new ResizeObserver(() => {
    if (oceanScene) refresh();
    else { resizeCanvas(); wake(); }
  });
  resize.observe(media);
  const menuObserver = menu ? new MutationObserver(refresh) : null;
  menuObserver?.observe(menu, {attributes:true, attributeFilter:['open']});
  const mediaVariantObserver = new MutationObserver(refresh);
  mediaVariantObserver.observe(landing, {attributes:true, attributeFilter:['data-media-variant']});
  refresh();

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      cancelVideoFrame();
      cleanups.forEach(cleanup => cleanup());
      intersection.disconnect();
      resize.disconnect();
      menuObserver?.disconnect();
      mediaVariantObserver.disconnect();
      resetScene();
      releaseGraphics();
      canvas.remove();
      media.style.removeProperty('--landing-projection-distance');
      ['pointerReady','refractionState','refractionReady','cursorMode','waterMask','cameraAnchor','productBounds','cameraFit','productFit','productSafe','cameraBaseScale','renderMode','rippleFrames'].forEach(key => { delete landing.dataset[key]; });
      ['--landing-cursor-x','--landing-cursor-y','--landing-cursor-scale'].forEach(property => landing.style.removeProperty(property));
      if (cursor) cursor.style.removeProperty('opacity');
    },
  };
}
