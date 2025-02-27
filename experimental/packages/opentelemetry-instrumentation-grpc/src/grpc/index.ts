/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as grpcTypes from 'grpc';
import {
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  InstrumentationBase,
  isWrapped,
} from '@opentelemetry/instrumentation';
import {
  GrpcInternalClientTypes,
  ServerCallWithMeta,
  SendUnaryDataCallback,
  GrpcClientFunc,
} from './types';
import { GrpcInstrumentationConfig } from '../types';
import { metadataCaptureType } from '../internal-types';
import {
  context,
  propagation,
  SpanOptions,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import {
  clientStreamAndUnaryHandler,
  shouldNotTraceServerCall,
  serverStreamAndBidiHandler,
} from './serverUtils';
import { makeGrpcClientRemoteCall, getMetadata } from './clientUtils';
import {
  _extractMethodAndService,
  _methodIsIgnored,
  metadataCapture,
  URI_REGEX,
} from '../utils';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { AttributeValues } from '../enums/AttributeValues';

/**
 * Holding reference to grpc module here to access constant of grpc modules
 * instead of just requiring it avoid directly depending on grpc itself.
 */
let grpcClient: typeof grpcTypes;

export class GrpcNativeInstrumentation extends InstrumentationBase<
  typeof grpcTypes
> {
  private _metadataCapture: metadataCaptureType;

  constructor(
    name: string,
    version: string,
    config?: GrpcInstrumentationConfig
  ) {
    super(name, version, config);
    this._metadataCapture = this._createMetadataCapture();
  }

  init() {
    return [
      new InstrumentationNodeModuleDefinition<typeof grpcTypes>(
        'grpc',
        ['1.*'],
        (moduleExports, version) => {
          this._diag.debug(`Applying patch for grpc@${version}`);
          grpcClient = moduleExports;

          if (isWrapped(moduleExports.Server.prototype.register)) {
            this._unwrap(moduleExports.Server.prototype, 'register');
          }
          this._wrap(
            moduleExports.Server.prototype,
            'register',
            this._patchServer() as any
          );
          // Wrap the externally exported client constructor
          if (isWrapped(moduleExports.makeGenericClientConstructor)) {
            this._unwrap(moduleExports, 'makeGenericClientConstructor');
          }
          this._wrap(
            moduleExports,
            'makeGenericClientConstructor',
            this._patchClient()
          );
          return moduleExports;
        },
        (moduleExports, version) => {
          if (moduleExports === undefined) return;
          this._diag.debug(`Removing patch for grpc@${version}`);

          this._unwrap(moduleExports.Server.prototype, 'register');
        },
        this._getInternalPatchs()
      ),
    ];
  }

  override getConfig(): GrpcInstrumentationConfig {
    return super.getConfig();
  }

  override setConfig(config?: GrpcInstrumentationConfig): void {
    super.setConfig(config);
    this._metadataCapture = this._createMetadataCapture();
  }

  private _getInternalPatchs() {
    const onPatch = (
      moduleExports: GrpcInternalClientTypes,
      version?: string
    ) => {
      this._diag.debug(`Applying internal patch for grpc@${version}`);
      if (isWrapped(moduleExports.makeClientConstructor)) {
        this._unwrap(moduleExports, 'makeClientConstructor');
      }
      this._wrap(moduleExports, 'makeClientConstructor', this._patchClient());
      return moduleExports;
    };
    const onUnPatch = (
      moduleExports?: GrpcInternalClientTypes,
      version?: string
    ) => {
      if (moduleExports === undefined) return;
      this._diag.debug(`Removing internal patch for grpc@${version}`);
      this._unwrap(moduleExports, 'makeClientConstructor');
    };
    return [
      new InstrumentationNodeModuleFile<GrpcInternalClientTypes>(
        'grpc/src/node/src/client.js',
        ['0.13 - 1.6'],
        onPatch,
        onUnPatch
      ),
      new InstrumentationNodeModuleFile<GrpcInternalClientTypes>(
        'grpc/src/client.js',
        ['^1.7'],
        onPatch,
        onUnPatch
      ),
    ];
  }

  private _patchServer() {
    const instrumentation = this;
    return (originalRegister: typeof grpcTypes.Server.prototype.register) => {
      instrumentation._diag.debug('patched gRPC server');

      return function register<RequestType, ResponseType>(
        this: grpcTypes.Server & { handlers: any },
        name: string,
        handler: grpcTypes.handleCall<RequestType, ResponseType>,
        serialize: grpcTypes.serialize<RequestType>,
        deserialize: grpcTypes.deserialize<RequestType>,
        type: string
      ) {
        const originalResult = originalRegister.apply(this, arguments as any);
        const handlerSet = this.handlers[name];

        instrumentation._wrap(
          handlerSet,
          'func',
          (originalFunc: grpcTypes.handleCall<RequestType, ResponseType>) => {
            return function func(
              this: typeof handlerSet,
              call: ServerCallWithMeta,
              callback: SendUnaryDataCallback
            ) {
              const self = this;
              if (shouldNotTraceServerCall.call(instrumentation, call, name)) {
                switch (type) {
                  case 'unary':
                  case 'client_stream':
                    return (originalFunc as Function).call(
                      self,
                      call,
                      callback
                    );
                  case 'server_stream':
                  case 'bidi':
                    return (originalFunc as Function).call(self, call);
                  default:
                    return originalResult;
                }
              }
              const spanName = `grpc.${name.replace('/', '')}`;
              const spanOptions: SpanOptions = {
                kind: SpanKind.SERVER,
              };

              instrumentation._diag.debug(
                `patch func: ${JSON.stringify(spanOptions)}`
              );

              context.with(
                propagation.extract(context.active(), call.metadata, {
                  get: (metadata, key) => metadata.get(key).map(String),
                  keys: metadata => Object.keys(metadata.getMap()),
                }),
                () => {
                  const { service, method } = _extractMethodAndService(name);

                  const span = instrumentation.tracer
                    .startSpan(spanName, spanOptions)
                    .setAttributes({
                      [SemanticAttributes.RPC_SYSTEM]:
                        AttributeValues.RPC_SYSTEM,
                      [SemanticAttributes.RPC_METHOD]: method,
                      [SemanticAttributes.RPC_SERVICE]: service,
                    });

                  instrumentation._metadataCapture.server.captureRequestMetadata(
                    span,
                    call.metadata
                  );

                  instrumentation._wrap(
                    call as any,
                    'sendMetadata',
                    originalSendMetadata =>
                      (responseMetadata: grpcTypes.Metadata) => {
                        instrumentation._metadataCapture.server.captureResponseMetadata(
                          span,
                          responseMetadata
                        );
                        originalSendMetadata.call(call, responseMetadata);
                      }
                  );

                  context.with(trace.setSpan(context.active(), span), () => {
                    switch (type) {
                      case 'unary':
                      case 'client_stream':
                        return clientStreamAndUnaryHandler(
                          span,
                          call,
                          callback,
                          originalFunc,
                          self
                        );
                      case 'server_stream':
                      case 'bidi':
                        return serverStreamAndBidiHandler(
                          span,
                          call,
                          originalFunc,
                          self
                        );
                      default:
                        break;
                    }
                  });
                }
              );
            };
          }
        );

        return originalResult;
      };
    };
  }

  private _patchClient() {
    const instrumentation = this;
    return (original: typeof grpcTypes.makeGenericClientConstructor): never => {
      instrumentation._diag.debug('patching client');
      return function makeClientConstructor(
        this: typeof grpcTypes.Client,
        methods: { [key: string]: { originalName?: string } },
        _serviceName: string,
        _options: grpcTypes.GenericClientOptions
      ) {
        const client = original.apply(this, arguments as any);
        instrumentation._massWrap(
          client.prototype as never,
          instrumentation._getMethodsToWrap(client, methods) as never[],
          instrumentation._getPatchedClientMethods() as any
        );
        return client;
      } as never;
    };
  }

  private _getMethodsToWrap(
    client: typeof grpcTypes.Client,
    methods: { [key: string]: { originalName?: string } }
  ): string[] {
    const methodList: string[] = [];

    // For a method defined in .proto as "UnaryMethod"
    Object.entries(methods).forEach(([name, { originalName }]) => {
      if (!_methodIsIgnored(name, this.getConfig().ignoreGrpcMethods)) {
        methodList.push(name); // adds camel case method name: "unaryMethod"
        if (
          originalName &&
          // eslint-disable-next-line no-prototype-builtins
          client.prototype.hasOwnProperty(originalName) &&
          name !== originalName // do not add duplicates
        ) {
          // adds original method name: "UnaryMethod",
          methodList.push(originalName);
        }
      }
    });
    return methodList;
  }

  private _getPatchedClientMethods() {
    const instrumentation = this;
    return (original: GrpcClientFunc) => {
      instrumentation._diag.debug('patch all client methods');
      function clientMethodTrace(this: grpcTypes.Client) {
        const name = `grpc.${(original.path as string | undefined)?.replace(
          '/',
          ''
        )}`;
        const args = Array.prototype.slice.call(arguments);
        const metadata = getMetadata(grpcClient, original, args);
        const { service, method } = _extractMethodAndService(original.path);
        const span = instrumentation.tracer
          .startSpan(name, {
            kind: SpanKind.CLIENT,
          })
          .setAttributes({
            [SemanticAttributes.RPC_SYSTEM]: AttributeValues.RPC_SYSTEM,
            [SemanticAttributes.RPC_METHOD]: method,
            [SemanticAttributes.RPC_SERVICE]: service,
          });
        // set net.peer.* from target (e.g., "dns:otel-productcatalogservice:8080") as a hint to APMs
        const parsedUri = URI_REGEX.exec(this.getChannel().getTarget());
        if (parsedUri != null && parsedUri.groups != null) {
          span.setAttribute(
            SemanticAttributes.NET_PEER_NAME,
            parsedUri.groups['name']
          );
          span.setAttribute(
            SemanticAttributes.NET_PEER_PORT,
            parseInt(parsedUri.groups['port'])
          );
        }

        instrumentation._metadataCapture.client.captureRequestMetadata(
          span,
          metadata
        );

        return context.with(trace.setSpan(context.active(), span), () =>
          makeGrpcClientRemoteCall(
            instrumentation._metadataCapture,
            original,
            args,
            metadata,
            this
          )(span)
        );
      }
      Object.assign(clientMethodTrace, original);
      return clientMethodTrace;
    };
  }

  private _createMetadataCapture(): metadataCaptureType {
    const config = this.getConfig();

    return {
      client: {
        captureRequestMetadata: metadataCapture(
          'request',
          config.metadataToSpanAttributes?.client?.requestMetadata ?? []
        ),
        captureResponseMetadata: metadataCapture(
          'response',
          config.metadataToSpanAttributes?.client?.responseMetadata ?? []
        ),
      },
      server: {
        captureRequestMetadata: metadataCapture(
          'request',
          config.metadataToSpanAttributes?.server?.requestMetadata ?? []
        ),
        captureResponseMetadata: metadataCapture(
          'response',
          config.metadataToSpanAttributes?.server?.responseMetadata ?? []
        ),
      },
    };
  }
}
