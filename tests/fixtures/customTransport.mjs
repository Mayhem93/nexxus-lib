import Transport from 'winston-transport';

// A real winston transport, exported both as a named export and as default,
// so the loader's export-resolution branches can be exercised.
export class MyTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    if (callback) {
      callback();
    }
  }
}

export default MyTransport;
