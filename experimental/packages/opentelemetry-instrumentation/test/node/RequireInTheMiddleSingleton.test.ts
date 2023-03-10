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

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import * as RequireInTheMiddle from 'require-in-the-middle';
import { RequireInTheMiddleSingleton } from '../../src/platform/node/RequireInTheMiddleSingleton';

type AugmentedExports = {
  __ritmOnRequires?: string[];
};

const makeOnRequiresStub = (label: string): sinon.SinonStub =>
  sinon.stub().callsFake(((exports: AugmentedExports) => {
    exports.__ritmOnRequires ??= [];
    exports.__ritmOnRequires.push(label);
    return exports;
  }) as RequireInTheMiddle.OnRequireFn);

describe('RequireInTheMiddleSingleton', () => {
  describe('default', () => {
    let requireInTheMiddleSingleton: RequireInTheMiddleSingleton;
    let onRequireFsStub: sinon.SinonStub;
    let onRequireFsPromisesStub: sinon.SinonStub;
    let onRequireCodecovStub: sinon.SinonStub;
    let onRequireCodecovLibStub: sinon.SinonStub;
    let onRequireCpxStub: sinon.SinonStub;
    let onRequireCpxLibStub: sinon.SinonStub;

    before(() => {
      onRequireFsStub = makeOnRequiresStub('fs');
      onRequireFsPromisesStub = makeOnRequiresStub('fs-promises');
      onRequireCodecovStub = makeOnRequiresStub('codecov');
      onRequireCodecovLibStub = makeOnRequiresStub('codecov-lib');
      onRequireCpxStub = makeOnRequiresStub('cpx');
      onRequireCpxLibStub = makeOnRequiresStub('cpx-lib');

      requireInTheMiddleSingleton = RequireInTheMiddleSingleton.getInstance();

      requireInTheMiddleSingleton.register('fs', onRequireFsStub);
      requireInTheMiddleSingleton.register(
        'fs/promises',
        onRequireFsPromisesStub
      );
      requireInTheMiddleSingleton.register('codecov', onRequireCodecovStub);
      requireInTheMiddleSingleton.register(
        'codecov/lib/codecov.js',
        onRequireCodecovLibStub
      );
      requireInTheMiddleSingleton.register('cpx', onRequireCpxStub);
      requireInTheMiddleSingleton.register(
        'cpx/lib/copy-sync.js',
        onRequireCpxLibStub
      );
    });

    beforeEach(() => {
      onRequireFsStub.resetHistory();
      onRequireFsPromisesStub.resetHistory();
      onRequireCodecovStub.resetHistory();
      onRequireCodecovLibStub.resetHistory();
      onRequireCpxStub.resetHistory();
      onRequireCpxLibStub.resetHistory();
    });

    after(() => {
      requireInTheMiddleSingleton.unhook();
    });

    it('should return a hooked object', () => {
      const moduleName = 'm';
      const onRequire = makeOnRequiresStub('m');
      const hooked = requireInTheMiddleSingleton.register(
        moduleName,
        onRequire
      );
      assert.deepStrictEqual(hooked, { moduleName, onRequire });
    });

    describe('core module', () => {
      describe('AND module name matches', () => {
        it('should call `onRequire`', () => {
          const exports = require('fs');
          assert.deepStrictEqual(exports.__ritmOnRequires, ['fs']);
          sinon.assert.calledOnceWithExactly(
            onRequireFsStub,
            exports,
            'fs',
            undefined
          );
          sinon.assert.notCalled(onRequireFsPromisesStub);
        });
      });
      describe('AND module name does not match', () => {
        it('should not call `onRequire`', () => {
          const exports = require('crypto');
          assert.equal(exports.__ritmOnRequires, undefined);
          sinon.assert.notCalled(onRequireFsStub);
        });
      });
    });

    describe('core module with sub-path', () => {
      describe('AND module name matches', () => {
        it('should call `onRequire`', () => {
          const exports = require('fs/promises');
          assert.deepStrictEqual(exports.__ritmOnRequires, ['fs-promises']);
          sinon.assert.calledOnceWithExactly(
            onRequireFsPromisesStub,
            exports,
            'fs/promises',
            undefined
          );
          sinon.assert.notCalled(onRequireFsStub);
        });
      });
    });

    describe('non-core module', () => {
      describe('AND module name matches', () => {
        const baseDir = path.dirname(require.resolve('codecov'));
        const modulePath = path.join('codecov', 'lib', 'codecov.js');
        it('should call `onRequire`', () => {
          const exports = require('codecov');
          assert.deepStrictEqual(exports.__ritmOnRequires, ['codecov']);
          sinon.assert.calledWithExactly(
            onRequireCodecovStub,
            exports,
            'codecov',
            baseDir
          );
          sinon.assert.calledWithMatch(
            onRequireCodecovStub,
            { __ritmOnRequires: ['codecov', 'codecov-lib'] },
            modulePath,
            baseDir
          );
          sinon.assert.calledWithMatch(
            onRequireCodecovLibStub,
            { __ritmOnRequires: ['codecov', 'codecov-lib'] },
            modulePath,
            baseDir
          );
        }).timeout(30000);
      });
    });

    describe('non-core module with sub-path', () => {
      describe('AND module name matches', () => {
        const baseDir = path.resolve(
          path.dirname(require.resolve('cpx')),
          '..'
        );
        const modulePath = path.join('cpx', 'lib', 'copy-sync.js');
        it('should call `onRequire`', () => {
          const exports = require('cpx/lib/copy-sync');
          assert.deepStrictEqual(exports.__ritmOnRequires, ['cpx', 'cpx-lib']);
          sinon.assert.calledWithMatch(
            onRequireCpxStub,
            { __ritmOnRequires: ['cpx', 'cpx-lib'] },
            modulePath,
            baseDir
          );
          sinon.assert.calledWithExactly(
            onRequireCpxStub,
            exports,
            modulePath,
            baseDir
          );
          sinon.assert.calledWithExactly(
            onRequireCpxLibStub,
            exports,
            modulePath,
            baseDir
          );
        });
      });
    });
  });

  describe('with OTEL_REQUIRE_ONLY set', () => {
    let requireInTheMiddleSingleton: RequireInTheMiddleSingleton;
    let onRequireFsStub: sinon.SinonStub;
    let onRequireCodecovStub: sinon.SinonStub;

    describe('single module', function () {
      before(() => {
        onRequireFsStub = makeOnRequiresStub('fs');
        onRequireCodecovStub = makeOnRequiresStub('codecov');

        process.env.OTEL_REQUIRE_ONLY = 'fs';
        requireInTheMiddleSingleton = RequireInTheMiddleSingleton.getInstance();

        requireInTheMiddleSingleton.register('fs', onRequireFsStub);
        requireInTheMiddleSingleton.register('codecov', onRequireCodecovStub);
      });

      beforeEach(() => {
        onRequireFsStub.resetHistory();
        onRequireCodecovStub.resetHistory();
      });

      after(() => {
        delete process.env.OTEL_REQUIRE_ONLY;
        requireInTheMiddleSingleton.unhook();
      });

      it('should call `onRequire` for fs', () => {
        require('fs');
        require('codecov');

        assert.equal(onRequireFsStub.called, true);
        assert.equal(onRequireCodecovStub.called, false);
      });
    });

    describe('multiple modules', function () {
      before(() => {
        onRequireFsStub = makeOnRequiresStub('fs');
        onRequireCodecovStub = makeOnRequiresStub('codecov');

        process.env.OTEL_REQUIRE_ONLY = 'fs,codecov';
        requireInTheMiddleSingleton = RequireInTheMiddleSingleton.getInstance();

        requireInTheMiddleSingleton.register('fs', onRequireFsStub);
        requireInTheMiddleSingleton.register('codecov', onRequireCodecovStub);
      });

      beforeEach(() => {
        onRequireFsStub.resetHistory();
        onRequireCodecovStub.resetHistory();
      });

      after(() => {
        delete process.env.OTEL_REQUIRE_ONLY;
      });

      it('should call `onRequire` for codecov & fs', () => {
        require('fs');
        require('codecov');

        assert.equal(onRequireFsStub.called, true);
        assert.equal(onRequireCodecovStub.called, true);
      });
    });
  });
});
