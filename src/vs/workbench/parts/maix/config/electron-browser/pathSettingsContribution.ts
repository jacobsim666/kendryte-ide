import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Extensions as CategoryExtensions, IConfigCategoryRegistry, INodePathService } from 'vs/workbench/parts/maix/_library/common/type';
import { Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { readdirSync } from 'vs/base/node/extfs';
import { executableExtension } from 'vs/workbench/parts/maix/_library/node/versions';
import { ILogService } from 'vs/platform/log/common/log';
import { resolvePath } from 'vs/workbench/parts/maix/_library/node/resolvePath';
import { existsSync, readFileSync } from 'fs';

interface SettingsOverwiter<T> {
	(access: ServicesAccessor, old: T): T;
}

const configOverwrites: { [id: string]: SettingsOverwiter<any> } = {
	'cmake.cmakePath'(access: ServicesAccessor) {
		const nodePathService = access.get<INodePathService>(INodePathService);
		return resolvePath(nodePathService.getPackagesPath('cmake/bin/cmake' + executableExtension));
	},
	'C_Cpp.default.compilerPath'(access: ServicesAccessor) {
		const nodePathService = access.get<INodePathService>(INodePathService);
		return resolvePath(nodePathService.getToolchainBinPath(), 'riscv64-unknown-elf-gcc' + executableExtension);
	},
	'C_Cpp.default.includePath'(access: ServicesAccessor) {
		const nodePathService = access.get<INodePathService>(INodePathService);
		const ret: string[] = [];
		const sdk = nodePathService.rawSDKPath();

		if (existsSync(resolvePath(sdk, '.IDE_INCLUDE'))) {
			const lines = readFileSync(resolvePath(sdk, '.IDE_INCLUDE'), 'utf8')
				.trim()
				.split(/\n/g)
				.map(e => e.trim())
				.filter(e => !!e)
				.map(e => resolvePath(sdk, e));
			ret.push(...lines);
		}
		ret.push(resolvePath(sdk, 'lib/bsp/include'));
		ret.push(resolvePath(sdk, 'lib/drivers/include'));
		ret.push(resolvePath(sdk, 'lib/freertos/include'));
		ret.push(resolvePath(sdk, 'lib/math/include'));
		ret.push(resolvePath(sdk, 'lib/utils/include'));

		ret.push(sdk + '/include');

		const toolchain = nodePathService.rawToolchainPath();
		ret.push(resolvePath(toolchain, 'riscv64-unknown-elf/include'));

		const libgcc = resolvePath(toolchain, 'lib/gcc/riscv64-unknown-elf');
		const libgccVersion = readdirSync(libgcc)[0];
		ret.push(resolvePath(libgcc, libgccVersion, 'include'));
		ret.push(resolvePath(libgcc, libgccVersion, 'include-fixed'));

		const libcpp = resolvePath(toolchain, 'riscv64-unknown-elf/include/c++');
		const libcppVersion = readdirSync(libcpp)[0];
		ret.push(resolvePath(libcpp, libcppVersion));
		ret.push(resolvePath(libcpp, libcppVersion, 'riscv64-unknown-elf'));

		return ret.filter((item, index) => {
			return ret.lastIndexOf(item) === index;
		});
	},
};

const setIfNot = new Map<string, any>();
setIfNot.set('workbench.list.openMode', 'doubleClick');
setIfNot.set('editor.cursorBlinking', 'smooth');
setIfNot.set('editor.cursorStyle', 'line-thin');
setIfNot.set('git.ignoreMissingGitWarning', true);
setIfNot.set('files.autoSave', 'afterDelay');
setIfNot.set('explorer.confirmDelete', false);
setIfNot.forEach((v, k) => {
	configOverwrites[k] = (a, user) => user === undefined ? v : undefined;
});

const forceOverride = new Map<string, any>();
forceOverride.set('cmake.generator', 'Unix Makefiles');
forceOverride.forEach((v, k) => {
	configOverwrites[k] = () => v;
});

class SettingCategoryContribution implements IWorkbenchContribution {
	private registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	private categoryRegistry = Registry.as<IConfigCategoryRegistry>(CategoryExtensions.ConfigCategory);

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ILogService private logService: ILogService,
	) {
		Object.keys(this.registry.getConfigurationProperties()).forEach((key: string) => this.checkCategory(key));
		this.registry.onDidRegisterConfiguration((keys: string[]) => keys.forEach(this.checkCategory, this));
	}

	private checkCategory(key: string) {
		const schema: IConfigurationPropertySchema = this.registry.getConfigurationProperties()[key];
		if (schema.hasOwnProperty('category')) {
			this.categoryRegistry.addSetting((schema as any).category, key);
		}
		const overwrite = configOverwrites[key];
		if (overwrite) {
			const old = this.configurationService.inspect(key);
			/// if (!old.user) {
			let value: any;
			try {
				value = this.instantiationService.invokeFunction(overwrite, old.user, old.default);
			} catch (e) {
				this.logService.error(`Failed to register config key: ${key}\n${e.stack}`);
			}
			if (value !== undefined) {
				this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
			}
			/// }
		}

		if (key === 'files.exclude') {
			this.hideBuildDirectory();
		}
	}

	private hideBuildDirectory() {
		const inspect = this.configurationService.inspect<any>('files.exclude');
		let data = inspect.user ? { ...inspect.user } : { ...inspect.default };
		let changed = { change: false };

		ignore(data, 'config/fpioa.cfg', changed);
		if (changed.change) {
			this.configurationService.updateValue('files.exclude', data, ConfigurationTarget.USER);
		}
	}
}

function ignore(data: any, name: string, changed: { change: boolean }) {
	if (!data.hasOwnProperty(name)) {
		changed.change = true;
		data[name] = true;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SettingCategoryContribution, LifecyclePhase.Running);
