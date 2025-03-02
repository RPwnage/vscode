/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { Action2, IAction2Options, MenuRegistry, registerAction2 } from 'vs/platform/actions/common/actions';
import { ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { localize } from 'vs/nls';
import { IEditSessionsStorageService, Change, ChangeType, Folder, EditSession, FileType, EDIT_SESSION_SYNC_CATEGORY, EDIT_SESSIONS_CONTAINER_ID, EditSessionSchemaVersion, IEditSessionsLogService, EDIT_SESSIONS_VIEW_ICON, EDIT_SESSIONS_TITLE, EDIT_SESSIONS_SHOW_VIEW, EDIT_SESSIONS_DATA_VIEW_ID, decodeEditSessionFileContent } from 'vs/workbench/contrib/editSessions/common/editSessions';
import { ISCMRepository, ISCMService } from 'vs/workbench/contrib/scm/common/scm';
import { IFileService } from 'vs/platform/files/common/files';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { URI } from 'vs/base/common/uri';
import { basename, joinPath, relativePath } from 'vs/base/common/resources';
import { encodeBase64 } from 'vs/base/common/buffer';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { EditSessionsWorkbenchService } from 'vs/workbench/contrib/editSessions/browser/editSessionsStorageService';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { UserDataSyncErrorCode, UserDataSyncStoreError } from 'vs/platform/userDataSync/common/userDataSync';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { getFileNamesMessage, IDialogService, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IProductService } from 'vs/platform/product/common/productService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { workbenchConfigurationNodeBase } from 'vs/workbench/common/configuration';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { ExtensionsRegistry } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ContextKeyExpr, ContextKeyExpression, IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { getVirtualWorkspaceLocation } from 'vs/platform/workspace/common/virtualWorkspace';
import { Schemas } from 'vs/base/common/network';
import { IsWebContext } from 'vs/platform/contextkey/common/contextkeys';
import { isProposedApiEnabled } from 'vs/workbench/services/extensions/common/extensions';
import { EditSessionsLogService } from 'vs/workbench/contrib/editSessions/common/editSessionsLogService';
import { IViewContainersRegistry, Extensions as ViewExtensions, ViewContainerLocation, IViewsService } from 'vs/workbench/common/views';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditSessionsDataViews } from 'vs/workbench/contrib/editSessions/browser/editSessionsViews';
import { EditSessionsFileSystemProvider } from 'vs/workbench/contrib/editSessions/browser/editSessionsFileSystemProvider';
import { isNative } from 'vs/base/common/platform';
import { WorkspaceFolderCountContext } from 'vs/workbench/common/contextkeys';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { equals } from 'vs/base/common/objects';
import { EditSessionIdentityMatch, IEditSessionIdentityService } from 'vs/platform/workspace/common/editSessions';
import { ThemeIcon } from 'vs/platform/theme/common/themeService';
import { IOutputService } from 'vs/workbench/services/output/common/output';
import * as Constants from 'vs/workbench/contrib/logs/common/logConstants';
import { sha1Hex } from 'vs/base/browser/hash';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { IActivityService, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

registerSingleton(IEditSessionsLogService, EditSessionsLogService, InstantiationType.Delayed);
registerSingleton(IEditSessionsStorageService, EditSessionsWorkbenchService, InstantiationType.Delayed);

const continueWorkingOnCommand: IAction2Options = {
	id: '_workbench.editSessions.actions.continueEditSession',
	title: { value: localize('continue working on', "Continue Working On..."), original: 'Continue Working On...' },
	precondition: WorkspaceFolderCountContext.notEqualsTo('0'),
	f1: true
};
const openLocalFolderCommand: IAction2Options = {
	id: '_workbench.editSessions.actions.continueEditSession.openLocalFolder',
	title: { value: localize('continue edit session in local folder', "Open In Local Folder"), original: 'Open In Local Folder' },
	category: EDIT_SESSION_SYNC_CATEGORY,
	precondition: IsWebContext
};
const showOutputChannelCommand: IAction2Options = {
	id: 'workbench.editSessions.actions.showOutputChannel',
	title: { value: localize('show log', 'Show Log'), original: 'Show Log' },
	category: EDIT_SESSION_SYNC_CATEGORY
};
const resumingProgressOptions = {
	location: ProgressLocation.Window,
	type: 'syncing',
	title: `[${localize('resuming edit session window', 'Resuming edit session...')}](command:${showOutputChannelCommand.id})`
};
const queryParamName = 'editSessionId';

const useEditSessionsWithContinueOn = 'workbench.editSessions.continueOn';
export class EditSessionsContribution extends Disposable implements IWorkbenchContribution {

	private continueEditSessionOptions: ContinueEditSessionItem[] = [];

	private readonly shouldShowViewsContext: IContextKey<boolean>;

	private static APPLICATION_LAUNCHED_VIA_CONTINUE_ON_STORAGE_KEY = 'applicationLaunchedViaContinueOn';
	private accountsMenuBadgeDisposable = this._register(new MutableDisposable());

	constructor(
		@IEditSessionsStorageService private readonly editSessionsStorageService: IEditSessionsStorageService,
		@IFileService private readonly fileService: IFileService,
		@IProgressService private readonly progressService: IProgressService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ISCMService private readonly scmService: ISCMService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditSessionsLogService private readonly logService: IEditSessionsLogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditSessionIdentityService private readonly editSessionIdentityService: IEditSessionIdentityService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IStorageService private readonly storageService: IStorageService,
		@IActivityService private readonly activityService: IActivityService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this.autoResumeEditSession();

		this.registerActions();
		this.registerViews();
		this.registerContributedEditSessionOptions();

		this.shouldShowViewsContext = EDIT_SESSIONS_SHOW_VIEW.bindTo(this.contextKeyService);

		this._register(this.fileService.registerProvider(EditSessionsFileSystemProvider.SCHEMA, new EditSessionsFileSystemProvider(this.editSessionsStorageService)));
		this.lifecycleService.onWillShutdown((e) => e.join(this.autoStoreEditSession(), { id: 'autoStoreEditSession', label: localize('autoStoreEditSession', 'Storing current edit session...') }));
		this._register(this.editSessionsStorageService.onDidSignIn(() => this.updateAccountsMenuBadge()));
		this._register(this.editSessionsStorageService.onDidSignOut(() => this.updateAccountsMenuBadge()));
	}

	private autoResumeEditSession() {
		void this.progressService.withProgress(resumingProgressOptions, async () => {
			performance.mark('code/willResumeEditSessionFromIdentifier');

			type ResumeEvent = {};
			type ResumeClassification = {
				owner: 'joyceerhl'; comment: 'Reporting when an action is resumed from an edit session identifier.';
			};
			this.telemetryService.publicLog2<ResumeEvent, ResumeClassification>('editSessions.continue.resume');

			const shouldAutoResumeOnReload = this.configurationService.getValue('workbench.editSessions.autoResume') === 'onReload';

			if (this.environmentService.editSessionId !== undefined) {
				this.logService.info(`Resuming edit session, reason: found editSessionId ${this.environmentService.editSessionId} in environment service...`);
				await this.resumeEditSession(this.environmentService.editSessionId).finally(() => this.environmentService.editSessionId = undefined);
			} else if (shouldAutoResumeOnReload && this.editSessionsStorageService.isSignedIn) {
				this.logService.info('Resuming edit session, reason: edit sessions enabled...');
				// Attempt to resume edit session based on edit workspace identifier
				// Note: at this point if the user is not signed into edit sessions,
				// we don't want them to be prompted to sign in and should just return early
				await this.resumeEditSession(undefined, true);
			} else if (shouldAutoResumeOnReload) {
				// The application has previously launched via a protocol URL Continue On flow
				const hasApplicationLaunchedFromContinueOnFlow = this.storageService.getBoolean(EditSessionsContribution.APPLICATION_LAUNCHED_VIA_CONTINUE_ON_STORAGE_KEY, StorageScope.APPLICATION, false);

				const handlePendingEditSessions = () => {
					// display a badge in the accounts menu but do not prompt the user to sign in again
					this.updateAccountsMenuBadge();
					// attempt a resume if we are in a pending state and the user just signed in
					const disposable = this.editSessionsStorageService.onDidSignIn(async () => {
						disposable.dispose();
						this.resumeEditSession(undefined, true);
						this.storageService.remove(EditSessionsContribution.APPLICATION_LAUNCHED_VIA_CONTINUE_ON_STORAGE_KEY, StorageScope.APPLICATION);
						this.environmentService.continueOn = undefined;
					});
				};

				if ((this.environmentService.continueOn !== undefined) &&
					!this.editSessionsStorageService.isSignedIn &&
					// and user has not yet been prompted to sign in on this machine
					hasApplicationLaunchedFromContinueOnFlow === false
				) {
					this.storageService.store(EditSessionsContribution.APPLICATION_LAUNCHED_VIA_CONTINUE_ON_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
					await this.editSessionsStorageService.initialize(true);
					if (this.editSessionsStorageService.isSignedIn) {
						await this.resumeEditSession(undefined, true);
					} else {
						handlePendingEditSessions();
					}
					// store the fact that we prompted the user
				} else if (!this.editSessionsStorageService.isSignedIn &&
					// and user has been prompted to sign in on this machine
					hasApplicationLaunchedFromContinueOnFlow === true
				) {
					handlePendingEditSessions();
				}
			}

			performance.mark('code/didResumeEditSessionFromIdentifier');
		});
	}

	private updateAccountsMenuBadge() {
		if (this.editSessionsStorageService.isSignedIn) {
			return this.accountsMenuBadgeDisposable.clear();
		}

		const badge = new NumberBadge(1, () => localize('check for pending edit sessions', 'Check for pending edit sessions'));
		this.accountsMenuBadgeDisposable.value = this.activityService.showAccountsActivity({ badge, priority: 1 });
	}

	private async autoStoreEditSession() {
		if (this.configurationService.getValue('workbench.experimental.editSessions.autoStore') === 'onShutdown') {
			await this.progressService.withProgress({
				location: ProgressLocation.Window,
				type: 'syncing',
				title: localize('store edit session', 'Storing edit session...')
			}, async () => this.storeEditSession(false));
		}
	}

	private registerViews() {
		const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
			{
				id: EDIT_SESSIONS_CONTAINER_ID,
				title: EDIT_SESSIONS_TITLE,
				ctorDescriptor: new SyncDescriptor(
					ViewPaneContainer,
					[EDIT_SESSIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]
				),
				icon: EDIT_SESSIONS_VIEW_ICON,
				hideIfEmpty: true
			}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true }
		);
		this._register(this.instantiationService.createInstance(EditSessionsDataViews, container));
	}

	private registerActions() {
		this.registerContinueEditSessionAction();

		this.registerResumeLatestEditSessionAction();
		this.registerStoreLatestEditSessionAction();

		this.registerContinueInLocalFolderAction();

		this.registerShowEditSessionViewAction();
		this.registerShowEditSessionOutputChannelAction();
	}

	private registerShowEditSessionOutputChannelAction() {
		this._register(registerAction2(class ShowEditSessionOutput extends Action2 {
			constructor() {
				super(showOutputChannelCommand);
			}

			run(accessor: ServicesAccessor, ...args: any[]) {
				const outputChannel = accessor.get(IOutputService);
				void outputChannel.showChannel(Constants.editSessionsLogChannelId);
			}
		}));
	}

	private registerShowEditSessionViewAction() {
		const that = this;
		this._register(registerAction2(class ShowEditSessionView extends Action2 {
			constructor() {
				super({
					id: 'workbench.editSessions.actions.showEditSessions',
					title: { value: localize('show edit session', "Show Edit Sessions"), original: 'Show Edit Sessions' },
					category: EDIT_SESSION_SYNC_CATEGORY,
					f1: true
				});
			}

			async run(accessor: ServicesAccessor) {
				that.shouldShowViewsContext.set(true);
				const viewsService = accessor.get(IViewsService);
				await viewsService.openView(EDIT_SESSIONS_DATA_VIEW_ID);
			}
		}));
	}

	private registerContinueEditSessionAction() {
		const that = this;
		this._register(registerAction2(class ContinueEditSessionAction extends Action2 {
			constructor() {
				super(continueWorkingOnCommand);
			}

			async run(accessor: ServicesAccessor, workspaceUri: URI | undefined): Promise<void> {
				type ContinueEditSessionEvent = {};
				type ContinueEditSessionClassification = {
					owner: 'joyceerhl'; comment: 'Reporting when the continue edit session action is run.';
				};
				that.telemetryService.publicLog2<ContinueEditSessionEvent, ContinueEditSessionClassification>('editSessions.continue.store');

				// First ask the user to pick a destination, if necessary
				let uri: URI | 'noDestinationUri' | undefined = workspaceUri;
				let destination;
				if (!uri) {
					destination = await that.pickContinueEditSessionDestination();
				}
				if (!destination && !uri) {
					return;
				}

				// Determine if we need to store an edit session, asking for edit session auth if necessary
				const shouldStoreEditSession = await that.shouldContinueOnWithEditSession();

				// Run the store action to get back a ref
				let ref: string | undefined;
				if (shouldStoreEditSession) {
					ref = await that.progressService.withProgress({
						location: ProgressLocation.Notification,
						type: 'syncing',
						title: localize('store your edit session', 'Storing your edit session...')
					}, async () => that.storeEditSession(false));
				}

				// Append the ref to the URI
				uri = destination ? await that.resolveDestination(destination) : uri;
				if (uri === undefined) {
					return;
				}

				if (ref !== undefined && uri !== 'noDestinationUri') {
					const encodedRef = encodeURIComponent(ref);
					uri = uri.with({
						query: uri.query.length > 0 ? (uri.query + `&${queryParamName}=${encodedRef}&continueOn=1`) : `${queryParamName}=${encodedRef}&continueOn=1`
					});

					// Open the URI
					that.logService.info(`Opening ${uri.toString()}`);
					await that.openerService.open(uri, { openExternal: true });
				} else if (!shouldStoreEditSession && uri !== 'noDestinationUri') {
					// Open the URI without an edit session ref
					that.logService.info(`Opening ${uri.toString()}`);
					await that.openerService.open(uri, { openExternal: true });
				} else if (ref === undefined && shouldStoreEditSession) {
					that.logService.warn(`Failed to store edit session when invoking ${continueWorkingOnCommand.id}.`);
				}
			}
		}));
	}

	private registerResumeLatestEditSessionAction(): void {
		const that = this;
		this._register(registerAction2(class ResumeLatestEditSessionAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.editSessions.actions.resumeLatest',
					title: { value: localize('resume latest.v2', "Resume Latest Edit Session"), original: 'Resume Latest Edit Session' },
					category: EDIT_SESSION_SYNC_CATEGORY,
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor, editSessionId?: string): Promise<void> {
				await that.progressService.withProgress(resumingProgressOptions, async () => {
					type ResumeEvent = {};
					type ResumeClassification = {
						owner: 'joyceerhl'; comment: 'Reporting when the resume edit session action is invoked.';
					};
					that.telemetryService.publicLog2<ResumeEvent, ResumeClassification>('editSessions.resume');

					await that.resumeEditSession(editSessionId);
				});
			}
		}));
	}

	private registerStoreLatestEditSessionAction(): void {
		const that = this;
		this._register(registerAction2(class StoreLatestEditSessionAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.editSessions.actions.storeCurrent',
					title: { value: localize('store current.v2', "Store Current Edit Session"), original: 'Store Current Edit Session' },
					category: EDIT_SESSION_SYNC_CATEGORY,
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				await that.progressService.withProgress({
					location: ProgressLocation.Notification,
					title: localize('storing edit session', 'Storing edit session...')
				}, async () => {
					type StoreEvent = {};
					type StoreClassification = {
						owner: 'joyceerhl'; comment: 'Reporting when the store edit session action is invoked.';
					};
					that.telemetryService.publicLog2<StoreEvent, StoreClassification>('editSessions.store');

					await that.storeEditSession(true);
				});
			}
		}));
	}

	async resumeEditSession(ref?: string, silent?: boolean, force?: boolean): Promise<void> {
		// Edit sessions are not currently supported in empty workspaces
		// https://github.com/microsoft/vscode/issues/159220
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		this.logService.info(ref !== undefined ? `Resuming edit session with ref ${ref}...` : 'Resuming edit session...');

		if (silent && !(await this.editSessionsStorageService.initialize(false, true))) {
			return;
		}

		const data = await this.editSessionsStorageService.read(ref);
		if (!data) {
			if (ref === undefined && !silent) {
				this.notificationService.info(localize('no edit session', 'There are no edit sessions to resume.'));
			} else if (ref !== undefined) {
				this.notificationService.warn(localize('no edit session content for ref', 'Could not resume edit session contents for ID {0}.', ref));
			}
			this.logService.info(ref !== undefined ? `Aborting resuming edit session as no edit session content is available to be applied from ref ${ref}.` : `Aborting resuming edit session as no edit session content is available to be applied`);
			return;
		}
		const editSession = data.editSession;
		ref = data.ref;

		if (editSession.version > EditSessionSchemaVersion) {
			this.notificationService.error(localize('client too old', "Please upgrade to a newer version of {0} to resume this edit session.", this.productService.nameLong));
			return;
		}

		try {
			const { changes, conflictingChanges } = await this.generateChanges(editSession, ref, force);
			if (changes.length === 0) {
				return;
			}

			// TODO@joyceerhl Provide the option to diff files which would be overwritten by edit session contents
			if (conflictingChanges.length > 0) {
				const yes = localize('resume edit session yes', 'Yes');
				const cancel = localize('resume edit session cancel', 'Cancel');
				// Allow to show edit sessions

				const result = await this.dialogService.show(
					Severity.Warning,
					conflictingChanges.length > 1 ?
						localize('resume edit session warning many', 'Resuming your edit session will overwrite the following {0} files. Do you want to proceed?', conflictingChanges.length) :
						localize('resume edit session warning 1', 'Resuming your edit session will overwrite {0}. Do you want to proceed?', basename(conflictingChanges[0].uri)),
					[cancel, yes],
					{
						detail: conflictingChanges.length > 1 ? getFileNamesMessage(conflictingChanges.map((c) => c.uri)) : undefined,
						cancelId: 0
					});

				if (result.choice === 0) {
					return;
				}
			}

			for (const { uri, type, contents } of changes) {
				if (type === ChangeType.Addition) {
					await this.fileService.writeFile(uri, decodeEditSessionFileContent(editSession.version, contents!));
				} else if (type === ChangeType.Deletion && await this.fileService.exists(uri)) {
					await this.fileService.del(uri);
				}
			}

			this.logService.info(`Deleting edit session with ref ${ref} after successfully applying it to current workspace...`);
			await this.editSessionsStorageService.delete(ref);
			this.logService.info(`Deleted edit session with ref ${ref}.`);
		} catch (ex) {
			this.logService.error('Failed to resume edit session, reason: ', (ex as Error).toString());
			this.notificationService.error(localize('resume failed', "Failed to resume your edit session."));
		}
	}

	private async generateChanges(editSession: EditSession, ref: string, force = false) {
		const changes: ({ uri: URI; type: ChangeType; contents: string | undefined })[] = [];
		const conflictingChanges = [];
		const workspaceFolders = this.contextService.getWorkspace().folders;

		for (const folder of editSession.folders) {
			const cancellationTokenSource = new CancellationTokenSource();
			let folderRoot: IWorkspaceFolder | undefined;

			if (folder.canonicalIdentity) {
				// Look for an edit session identifier that we can use
				for (const f of workspaceFolders) {
					const identity = await this.editSessionIdentityService.getEditSessionIdentifier(f, cancellationTokenSource);
					this.logService.info(`Matching identity ${identity} against edit session folder identity ${folder.canonicalIdentity}...`);

					if (equals(identity, folder.canonicalIdentity)) {
						folderRoot = f;
						break;
					}

					if (identity !== undefined) {
						const match = await this.editSessionIdentityService.provideEditSessionIdentityMatch(f, identity, folder.canonicalIdentity, cancellationTokenSource);
						if (match === EditSessionIdentityMatch.Complete) {
							folderRoot = f;
							break;
						} else if (match === EditSessionIdentityMatch.Partial &&
							this.configurationService.getValue('workbench.experimental.editSessions.partialMatches.enabled') === true
						) {
							if (!force) {
								// Surface partially matching edit session
								this.notificationService.prompt(
									Severity.Info,
									localize('editSessionPartialMatch', 'You have a pending edit session for this workspace. Would you like to resume it?'),
									[{ label: localize('resume', 'Resume'), run: () => this.resumeEditSession(ref, false, true) }]
								);
							} else {
								folderRoot = f;
								break;
							}
						}
					}
				}
			} else {
				folderRoot = workspaceFolders.find((f) => f.name === folder.name);
			}

			if (!folderRoot) {
				this.logService.info(`Skipping applying ${folder.workingChanges.length} changes from edit session with ref ${ref} as no matching workspace folder was found.`);
				return { changes: [], conflictingChanges: [] };
			}

			const localChanges = new Set<string>();
			for (const repository of this.scmService.repositories) {
				if (repository.provider.rootUri !== undefined &&
					this.contextService.getWorkspaceFolder(repository.provider.rootUri)?.name === folder.name
				) {
					const repositoryChanges = this.getChangedResources(repository);
					repositoryChanges.forEach((change) => localChanges.add(change.toString()));
				}
			}

			for (const change of folder.workingChanges) {
				const uri = joinPath(folderRoot.uri, change.relativeFilePath);

				changes.push({ uri, type: change.type, contents: change.contents });
				if (await this.willChangeLocalContents(localChanges, uri, change)) {
					conflictingChanges.push({ uri, type: change.type, contents: change.contents });
				}
			}
		}

		return { changes, conflictingChanges };
	}

	private async willChangeLocalContents(localChanges: Set<string>, uriWithIncomingChanges: URI, incomingChange: Change) {
		if (!localChanges.has(uriWithIncomingChanges.toString())) {
			return false;
		}

		const { contents, type } = incomingChange;

		switch (type) {
			case (ChangeType.Addition): {
				const [originalContents, incomingContents] = await Promise.all([sha1Hex(contents), sha1Hex(encodeBase64((await this.fileService.readFile(uriWithIncomingChanges)).value))]);
				return originalContents !== incomingContents;
			}
			case (ChangeType.Deletion): {
				return await this.fileService.exists(uriWithIncomingChanges);
			}
			default:
				throw new Error('Unhandled change type.');
		}
	}

	async storeEditSession(fromStoreCommand: boolean): Promise<string | undefined> {
		const folders: Folder[] = [];
		let hasEdits = false;

		// Save all saveable editors before building edit session contents
		await this.editorService.saveAll();

		for (const repository of this.scmService.repositories) {
			// Look through all resource groups and compute which files were added/modified/deleted
			const trackedUris = this.getChangedResources(repository); // A URI might appear in more than one resource group

			const workingChanges: Change[] = [];

			const { rootUri } = repository.provider;
			const workspaceFolder = rootUri ? this.contextService.getWorkspaceFolder(rootUri) : undefined;
			let name = workspaceFolder?.name;

			for (const uri of trackedUris) {
				const workspaceFolder = this.contextService.getWorkspaceFolder(uri);
				if (!workspaceFolder) {
					this.logService.info(`Skipping working change ${uri.toString()} as no associated workspace folder was found.`);

					continue;
				}

				name = name ?? workspaceFolder.name;
				const relativeFilePath = relativePath(workspaceFolder.uri, uri) ?? uri.path;

				// Only deal with file contents for now
				try {
					if (!(await this.fileService.stat(uri)).isFile) {
						continue;
					}
				} catch { }

				hasEdits = true;

				if (await this.fileService.exists(uri)) {
					const contents = encodeBase64((await this.fileService.readFile(uri)).value);
					workingChanges.push({ type: ChangeType.Addition, fileType: FileType.File, contents: contents, relativeFilePath: relativeFilePath });
				} else {
					// Assume it's a deletion
					workingChanges.push({ type: ChangeType.Deletion, fileType: FileType.File, contents: undefined, relativeFilePath: relativeFilePath });
				}
			}

			const canonicalIdentity = workspaceFolder ? await this.editSessionIdentityService.getEditSessionIdentifier(workspaceFolder, new CancellationTokenSource()) : undefined;

			folders.push({ workingChanges, name: name ?? '', canonicalIdentity: canonicalIdentity ?? undefined });
		}

		if (!hasEdits) {
			this.logService.info('Skipping storing edit session as there are no edits to store.');
			if (fromStoreCommand) {
				this.notificationService.info(localize('no edits to store', 'Skipped storing edit session as there are no edits to store.'));
			}
			return undefined;
		}

		const data: EditSession = { folders, version: 2 };

		try {
			this.logService.info(`Storing edit session...`);
			const ref = await this.editSessionsStorageService.write(data);
			this.logService.info(`Stored edit session with ref ${ref}.`);
			return ref;
		} catch (ex) {
			this.logService.error(`Failed to store edit session, reason: `, (ex as Error).toString());

			type UploadFailedEvent = { reason: string };
			type UploadFailedClassification = {
				owner: 'joyceerhl'; comment: 'Reporting when Continue On server request fails.';
				reason?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The reason that the server request failed.' };
			};

			if (ex instanceof UserDataSyncStoreError) {
				switch (ex.code) {
					case UserDataSyncErrorCode.TooLarge:
						// Uploading a payload can fail due to server size limits
						this.telemetryService.publicLog2<UploadFailedEvent, UploadFailedClassification>('editSessions.upload.failed', { reason: 'TooLarge' });
						this.notificationService.error(localize('payload too large', 'Your edit session exceeds the size limit and cannot be stored.'));
						break;
					default:
						this.telemetryService.publicLog2<UploadFailedEvent, UploadFailedClassification>('editSessions.upload.failed', { reason: 'unknown' });
						this.notificationService.error(localize('payload failed', 'Your edit session cannot be stored.'));
						break;
				}
			}
		}

		return undefined;
	}

	private getChangedResources(repository: ISCMRepository) {
		return repository.provider.groups.elements.reduce((resources, resourceGroups) => {
			resourceGroups.elements.forEach((resource) => resources.add(resource.sourceUri));
			return resources;
		}, new Set<URI>()); // A URI might appear in more than one resource group
	}

	private hasEditSession() {
		for (const repository of this.scmService.repositories) {
			if (this.getChangedResources(repository).size > 0) {
				return true;
			}
		}
		return false;
	}

	private async shouldContinueOnWithEditSession(): Promise<boolean> {
		// If the user is already signed in, we should store edit session
		if (this.editSessionsStorageService.isSignedIn) {
			return this.hasEditSession();
		}

		// If the user has been asked before and said no, don't use edit sessions
		if (this.configurationService.getValue(useEditSessionsWithContinueOn) === 'off') {
			return false;
		}

		// Prompt the user to use edit sessions if they currently could benefit from using it
		if (this.hasEditSession()) {
			return this.editSessionsStorageService.initialize(true);
		}

		return false;
	}

	//#region Continue Edit Session extension contribution point

	private registerContributedEditSessionOptions() {
		continueEditSessionExtPoint.setHandler(extensions => {
			const continueEditSessionOptions: ContinueEditSessionItem[] = [];
			for (const extension of extensions) {
				if (!isProposedApiEnabled(extension.description, 'contribEditSessions')) {
					continue;
				}
				if (!Array.isArray(extension.value)) {
					continue;
				}
				for (const contribution of extension.value) {
					const command = MenuRegistry.getCommand(contribution.command);
					if (!command) {
						return;
					}

					const icon = command.icon;
					const title = typeof command.title === 'string' ? command.title : command.title.value;

					continueEditSessionOptions.push(new ContinueEditSessionItem(
						ThemeIcon.isThemeIcon(icon) ? `$(${icon.id}) ${title}` : title,
						command.id,
						command.source,
						ContextKeyExpr.deserialize(contribution.when)
					));
				}
			}
			this.continueEditSessionOptions = continueEditSessionOptions;
		});
	}

	private registerContinueInLocalFolderAction(): void {
		const that = this;
		this._register(registerAction2(class ContinueInLocalFolderAction extends Action2 {
			constructor() {
				super(openLocalFolderCommand);
			}

			async run(accessor: ServicesAccessor): Promise<URI | undefined> {
				const selection = await that.fileDialogService.showOpenDialog({
					title: localize('continueEditSession.openLocalFolder.title', 'Select a local folder to continue your edit session in'),
					canSelectFolders: true,
					canSelectMany: false,
					canSelectFiles: false,
					availableFileSystems: [Schemas.file]
				});

				return selection?.length !== 1 ? undefined : URI.from({
					scheme: that.productService.urlProtocol,
					authority: Schemas.file,
					path: selection[0].path
				});
			}
		}));
	}

	private async pickContinueEditSessionDestination(): Promise<string | undefined> {
		const quickPick = this.quickInputService.createQuickPick<ContinueEditSessionItem>();

		const workspaceContext = this.contextService.getWorkbenchState() === WorkbenchState.FOLDER
			? this.contextService.getWorkspace().folders[0].name
			: this.contextService.getWorkspace().folders.map((folder) => folder.name).join(', ');
		quickPick.placeholder = localize('continueEditSessionPick.title.v2', "Select a development environment to continue working on {0} in", `'${workspaceContext}'`);
		quickPick.items = this.createPickItems();

		const command = await new Promise<string | undefined>((resolve, reject) => {
			quickPick.onDidHide(() => resolve(undefined));

			quickPick.onDidAccept((e) => {
				const selection = quickPick.activeItems[0].command;
				resolve(selection);
				quickPick.hide();
			});

			quickPick.show();
		});

		quickPick.dispose();

		return command;
	}

	private async resolveDestination(command: string): Promise<URI | 'noDestinationUri' | undefined> {
		try {
			const uri = await this.commandService.executeCommand(command);

			// Some continue on commands do not return a URI
			// to support extensions which want to be in control
			// of how the destination is opened
			if (uri === undefined) { return 'noDestinationUri'; }

			return URI.isUri(uri) ? uri : undefined;
		} catch (ex) {
			return undefined;
		}
	}

	private createPickItems(): ContinueEditSessionItem[] {
		const items = [...this.continueEditSessionOptions].filter((option) => option.when === undefined || this.contextKeyService.contextMatchesRules(option.when));

		if (getVirtualWorkspaceLocation(this.contextService.getWorkspace()) !== undefined && isNative) {
			items.push(new ContinueEditSessionItem(
				'$(folder) ' + localize('continueEditSessionItem.openInLocalFolder.v2', 'Open in Local Folder'),
				openLocalFolderCommand.id,
				localize('continueEditSessionItem.builtin', 'Built-in')
			));
		}

		return items.sort((item1, item2) => item1.label.localeCompare(item2.label));
	}
}

class ContinueEditSessionItem implements IQuickPickItem {
	constructor(
		public readonly label: string,
		public readonly command: string,
		public readonly description?: string,
		public readonly when?: ContextKeyExpression,
	) { }
}

interface ICommand {
	command: string;
	group: string;
	when: string;
}

const continueEditSessionExtPoint = ExtensionsRegistry.registerExtensionPoint<ICommand[]>({
	extensionPoint: 'continueEditSession',
	jsonSchema: {
		description: localize('continueEditSessionExtPoint', 'Contributes options for continuing the current edit session in a different environment'),
		type: 'array',
		items: {
			type: 'object',
			properties: {
				command: {
					description: localize('continueEditSessionExtPoint.command', 'Identifier of the command to execute. The command must be declared in the \'commands\'-section and return a URI representing a different environment where the current edit session can be continued.'),
					type: 'string'
				},
				group: {
					description: localize('continueEditSessionExtPoint.group', 'Group into which this item belongs.'),
					type: 'string'
				},
				when: {
					description: localize('continueEditSessionExtPoint.when', 'Condition which must be true to show this item.'),
					type: 'string'
				}
			},
			required: ['command']
		}
	}
});

//#endregion

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(EditSessionsContribution, LifecyclePhase.Restored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	'properties': {
		'workbench.experimental.editSessions.autoStore': {
			enum: ['onShutdown', 'off'],
			enumDescriptions: [
				localize('autoStore.onShutdown', "Automatically store current edit session on window close."),
				localize('autoStore.off', "Never attempt to automatically store an edit session.")
			],
			'type': 'string',
			'tags': ['experimental', 'usesOnlineServices'],
			'default': 'off',
			'markdownDescription': localize('autoStore', "Controls whether to automatically store an available edit session for the current workspace."),
		},
		'workbench.editSessions.autoResume': {
			enum: ['onReload', 'off'],
			enumDescriptions: [
				localize('autoResume.onReload', "Automatically resume available edit session on window reload."),
				localize('autoResume.off', "Never attempt to resume an edit session.")
			],
			'type': 'string',
			'tags': ['usesOnlineServices'],
			'default': 'onReload',
			'markdownDescription': localize('autoResume', "Controls whether to automatically resume an available edit session for the current workspace."),
		},
		'workbench.editSessions.continueOn': {
			enum: ['prompt', 'off'],
			enumDescriptions: [
				localize('continueOn.promptForAuth', 'Prompt the user to sign in to store edit sessions with Continue Working On.'),
				localize('continueOn.off', 'Do not use edit sessions with Continue Working On unless the user has already turned on edit sessions.')
			],
			type: 'string',
			tags: ['usesOnlineServices'],
			default: 'prompt',
			markdownDescription: localize('continueOn', 'Controls whether to prompt the user to store edit sessions when using Continue Working On.')
		},
		'workbench.experimental.editSessions.continueOn': {
			enum: ['prompt', 'off'],
			enumDescriptions: [
				localize('continueOn.promptForAuth', 'Prompt the user to sign in to store edit sessions with Continue Working On.'),
				localize('continueOn.off', 'Do not use edit sessions with Continue Working On unless the user has already turned on edit sessions.')
			],
			type: 'string',
			tags: ['experimental', 'usesOnlineServices'],
			default: 'prompt',
			markdownDeprecationMessage: localize('continueOnDeprecated', 'This setting is deprecated in favor of {0}.', '`#workbench.experimental.continueOn#`'),
			markdownDescription: localize('continueOn', 'Controls whether to prompt the user to store edit sessions when using Continue Working On.')
		},
		'workbench.experimental.editSessions.enabled': {
			'type': 'boolean',
			'tags': ['experimental', 'usesOnlineServices'],
			'default': true,
			'markdownDeprecationMessage': localize('editSessionsEnabledDeprecated', "This setting is deprecated as Edit Sessions are no longer experimental. Please see {0} and {1} for configuring behavior related to Edit Sessions.", '`#workbench.editSessions.autoResume#`', '`#workbench.editSessions.continueOn#`')
		},
		'workbench.experimental.editSessions.autoResume': {
			enum: ['onReload', 'off'],
			enumDescriptions: [
				localize('autoResume.onReload', "Automatically resume available edit session on window reload."),
				localize('autoResume.off', "Never attempt to resume an edit session.")
			],
			'type': 'string',
			'tags': ['experimental', 'usesOnlineServices'],
			'default': 'onReload',
			'markdownDeprecationMessage': localize('autoResumeDeprecated', "This setting is deprecated in favor of {0}.", '`#workbench.editSessions.autoResume#`')
		},
		'workbench.experimental.editSessions.partialMatches.enabled': {
			'type': 'boolean',
			'tags': ['experimental', 'usesOnlineServices'],
			'default': false,
			'markdownDescription': localize('editSessionsPartialMatchesEnabled', "Controls whether to surface edit sessions which partially match the current session.")
		}
	}
});
