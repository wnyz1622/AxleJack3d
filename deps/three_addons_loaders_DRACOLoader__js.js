import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FileLoader,
  LinearSRGBColorSpace,
  Loader,
  SRGBColorSpace
} from "./chunk-YWGNMRD2.js";

// ../node_modules/three/examples/jsm/loaders/DRACOLoader.js
var _taskCache = /* @__PURE__ */ new WeakMap();
var DRACOLoader = class extends Loader {
  constructor(manager) {
    super(manager);
    this.decoderPath = "";
    this.decoderConfig = {};
    this.decoderBinary = null;
    this.decoderPending = null;
    this.workerLimit = 4;
    this.workerPool = [];
    this.workerNextTaskID = 1;
    this.workerSourceURL = "";
    this.defaultAttributeIDs = {
      position: "POSITION",
      normal: "NORMAL",
      color: "COLOR",
      uv: "TEX_COORD"
    };
    this.defaultAttributeTypes = {
      position: "Float32Array",
      normal: "Float32Array",
      color: "Float32Array",
      uv: "Float32Array"
    };
  }
  setDecoderPath(path) {
    this.decoderPath = path;
    return this;
  }
  setDecoderConfig(config) {
    this.decoderConfig = config;
    return this;
  }
  setWorkerLimit(workerLimit) {
    this.workerLimit = workerLimit;
    return this;
  }
  load(url, onLoad, onProgress, onError) {
    const loader = new FileLoader(this.manager);
    loader.setPath(this.path);
    loader.setResponseType("arraybuffer");
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);
    loader.load(url, (buffer) => {
      this.parse(buffer, onLoad, onError);
    }, onProgress, onError);
  }
  parse(buffer, onLoad, onError = () => {
  }) {
    this.decodeDracoFile(buffer, onLoad, null, null, SRGBColorSpace).catch(onError);
  }
  decodeDracoFile(buffer, callback, attributeIDs, attributeTypes, vertexColorSpace = LinearSRGBColorSpace, onError = () => {
  }) {
    const taskConfig = {
      attributeIDs: attributeIDs || this.defaultAttributeIDs,
      attributeTypes: attributeTypes || this.defaultAttributeTypes,
      useUniqueIDs: !!attributeIDs,
      vertexColorSpace
    };
    return this.decodeGeometry(buffer, taskConfig).then(callback).catch(onError);
  }
  decodeGeometry(buffer, taskConfig) {
    const taskKey = JSON.stringify(taskConfig);
    if (_taskCache.has(buffer)) {
      const cachedTask = _taskCache.get(buffer);
      if (cachedTask.key === taskKey) {
        return cachedTask.promise;
      } else if (buffer.byteLength === 0) {
        throw new Error(
          "THREE.DRACOLoader: Unable to re-decode a buffer with different settings. Buffer has already been transferred."
        );
      }
    }
    let worker;
    const taskID = this.workerNextTaskID++;
    const taskCost = buffer.byteLength;
    const geometryPending = this._getWorker(taskID, taskCost).then((_worker) => {
      worker = _worker;
      return new Promise((resolve, reject) => {
        worker._callbacks[taskID] = { resolve, reject };
        worker.postMessage({ type: "decode", id: taskID, taskConfig, buffer }, [buffer]);
      });
    }).then((message) => this._createGeometry(message.geometry));
    geometryPending.catch(() => true).then(() => {
      if (worker && taskID) {
        this._releaseTask(worker, taskID);
      }
    });
    _taskCache.set(buffer, {
      key: taskKey,
      promise: geometryPending
    });
    return geometryPending;
  }
  _createGeometry(geometryData) {
    const geometry = new BufferGeometry();
    if (geometryData.index) {
      geometry.setIndex(new BufferAttribute(geometryData.index.array, 1));
    }
    for (let i = 0; i < geometryData.attributes.length; i++) {
      const result = geometryData.attributes[i];
      const name = result.name;
      const array = result.array;
      const itemSize = result.itemSize;
      const attribute = new BufferAttribute(array, itemSize);
      if (name === "color") {
        this._assignVertexColorSpace(attribute, result.vertexColorSpace);
        attribute.normalized = array instanceof Float32Array === false;
      }
      geometry.setAttribute(name, attribute);
    }
    return geometry;
  }
  _assignVertexColorSpace(attribute, inputColorSpace) {
    if (inputColorSpace !== SRGBColorSpace) return;
    const _color = new Color();
    for (let i = 0, il = attribute.count; i < il; i++) {
      _color.fromBufferAttribute(attribute, i).convertSRGBToLinear();
      attribute.setXYZ(i, _color.r, _color.g, _color.b);
    }
  }
  _loadLibrary(url, responseType) {
    const loader = new FileLoader(this.manager);
    loader.setPath(this.decoderPath);
    loader.setResponseType(responseType);
    loader.setWithCredentials(this.withCredentials);
    return new Promise((resolve, reject) => {
      loader.load(url, resolve, void 0, reject);
    });
  }
  preload() {
    this._initDecoder();
    return this;
  }
  _initDecoder() {
    if (this.decoderPending) return this.decoderPending;
    const useJS = typeof WebAssembly !== "object" || this.decoderConfig.type === "js";
    const librariesPending = [];
    if (useJS) {
      librariesPending.push(this._loadLibrary("draco_decoder.js", "text"));
    } else {
      librariesPending.push(this._loadLibrary("draco_wasm_wrapper.js", "text"));
      librariesPending.push(this._loadLibrary("draco_decoder.wasm", "arraybuffer"));
    }
    this.decoderPending = Promise.all(librariesPending).then((libraries) => {
      const jsContent = libraries[0];
      if (!useJS) {
        this.decoderConfig.wasmBinary = libraries[1];
      }
      const fn = DRACOWorker.toString();
      const body = [
        "/* draco decoder */",
        jsContent,
        "",
        "/* worker */",
        fn.substring(fn.indexOf("{") + 1, fn.lastIndexOf("}"))
      ].join("\n");
      this.workerSourceURL = URL.createObjectURL(new Blob([body]));
    });
    return this.decoderPending;
  }
  _getWorker(taskID, taskCost) {
    return this._initDecoder().then(() => {
      if (this.workerPool.length < this.workerLimit) {
        const worker2 = new Worker(this.workerSourceURL);
        worker2._callbacks = {};
        worker2._taskCosts = {};
        worker2._taskLoad = 0;
        worker2.postMessage({ type: "init", decoderConfig: this.decoderConfig });
        worker2.onmessage = function(e) {
          const message = e.data;
          switch (message.type) {
            case "decode":
              worker2._callbacks[message.id].resolve(message);
              break;
            case "error":
              worker2._callbacks[message.id].reject(message);
              break;
            default:
              console.error('THREE.DRACOLoader: Unexpected message, "' + message.type + '"');
          }
        };
        this.workerPool.push(worker2);
      } else {
        this.workerPool.sort(function(a, b) {
          return a._taskLoad > b._taskLoad ? -1 : 1;
        });
      }
      const worker = this.workerPool[this.workerPool.length - 1];
      worker._taskCosts[taskID] = taskCost;
      worker._taskLoad += taskCost;
      return worker;
    });
  }
  _releaseTask(worker, taskID) {
    worker._taskLoad -= worker._taskCosts[taskID];
    delete worker._callbacks[taskID];
    delete worker._taskCosts[taskID];
  }
  debug() {
    console.log("Task load: ", this.workerPool.map((worker) => worker._taskLoad));
  }
  dispose() {
    for (let i = 0; i < this.workerPool.length; ++i) {
      this.workerPool[i].terminate();
    }
    this.workerPool.length = 0;
    if (this.workerSourceURL !== "") {
      URL.revokeObjectURL(this.workerSourceURL);
    }
    return this;
  }
};
function DRACOWorker() {
  let decoderConfig;
  let decoderPending;
  onmessage = function(e) {
    const message = e.data;
    switch (message.type) {
      case "init":
        decoderConfig = message.decoderConfig;
        decoderPending = new Promise(function(resolve) {
          decoderConfig.onModuleLoaded = function(draco) {
            resolve({ draco });
          };
          DracoDecoderModule(decoderConfig);
        });
        break;
      case "decode":
        const buffer = message.buffer;
        const taskConfig = message.taskConfig;
        decoderPending.then((module) => {
          const draco = module.draco;
          const decoder = new draco.Decoder();
          try {
            const geometry = decodeGeometry(draco, decoder, new Int8Array(buffer), taskConfig);
            const buffers = geometry.attributes.map((attr) => attr.array.buffer);
            if (geometry.index) buffers.push(geometry.index.array.buffer);
            self.postMessage({ type: "decode", id: message.id, geometry }, buffers);
          } catch (error) {
            console.error(error);
            self.postMessage({ type: "error", id: message.id, error: error.message });
          } finally {
            draco.destroy(decoder);
          }
        });
        break;
    }
  };
  function decodeGeometry(draco, decoder, array, taskConfig) {
    const attributeIDs = taskConfig.attributeIDs;
    const attributeTypes = taskConfig.attributeTypes;
    let dracoGeometry;
    let decodingStatus;
    const geometryType = decoder.GetEncodedGeometryType(array);
    if (geometryType === draco.TRIANGULAR_MESH) {
      dracoGeometry = new draco.Mesh();
      decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
    } else if (geometryType === draco.POINT_CLOUD) {
      dracoGeometry = new draco.PointCloud();
      decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
    } else {
      throw new Error("THREE.DRACOLoader: Unexpected geometry type.");
    }
    if (!decodingStatus.ok() || dracoGeometry.ptr === 0) {
      throw new Error("THREE.DRACOLoader: Decoding failed: " + decodingStatus.error_msg());
    }
    const geometry = { index: null, attributes: [] };
    for (const attributeName in attributeIDs) {
      const attributeType = self[attributeTypes[attributeName]];
      let attribute;
      let attributeID;
      if (taskConfig.useUniqueIDs) {
        attributeID = attributeIDs[attributeName];
        attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeID);
      } else {
        attributeID = decoder.GetAttributeId(dracoGeometry, draco[attributeIDs[attributeName]]);
        if (attributeID === -1) continue;
        attribute = decoder.GetAttribute(dracoGeometry, attributeID);
      }
      const attributeResult = decodeAttribute(draco, decoder, dracoGeometry, attributeName, attributeType, attribute);
      if (attributeName === "color") {
        attributeResult.vertexColorSpace = taskConfig.vertexColorSpace;
      }
      geometry.attributes.push(attributeResult);
    }
    if (geometryType === draco.TRIANGULAR_MESH) {
      geometry.index = decodeIndex(draco, decoder, dracoGeometry);
    }
    draco.destroy(dracoGeometry);
    return geometry;
  }
  function decodeIndex(draco, decoder, dracoGeometry) {
    const numFaces = dracoGeometry.num_faces();
    const numIndices = numFaces * 3;
    const byteLength = numIndices * 4;
    const ptr = draco._malloc(byteLength);
    decoder.GetTrianglesUInt32Array(dracoGeometry, byteLength, ptr);
    const index = new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice();
    draco._free(ptr);
    return { array: index, itemSize: 1 };
  }
  function decodeAttribute(draco, decoder, dracoGeometry, attributeName, attributeType, attribute) {
    const numComponents = attribute.num_components();
    const numPoints = dracoGeometry.num_points();
    const numValues = numPoints * numComponents;
    const byteLength = numValues * attributeType.BYTES_PER_ELEMENT;
    const dataType = getDracoDataType(draco, attributeType);
    const ptr = draco._malloc(byteLength);
    decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dataType, byteLength, ptr);
    const array = new attributeType(draco.HEAPF32.buffer, ptr, numValues).slice();
    draco._free(ptr);
    return {
      name: attributeName,
      array,
      itemSize: numComponents
    };
  }
  function getDracoDataType(draco, attributeType) {
    switch (attributeType) {
      case Float32Array:
        return draco.DT_FLOAT32;
      case Int8Array:
        return draco.DT_INT8;
      case Int16Array:
        return draco.DT_INT16;
      case Int32Array:
        return draco.DT_INT32;
      case Uint8Array:
        return draco.DT_UINT8;
      case Uint16Array:
        return draco.DT_UINT16;
      case Uint32Array:
        return draco.DT_UINT32;
    }
  }
}
export {
  DRACOLoader
};
//# sourceMappingURL=three_addons_loaders_DRACOLoader__js.js.map
