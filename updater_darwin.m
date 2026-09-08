#import <Cocoa/Cocoa.h>

// Resolve Sparkle from the signed app bundle. Unit tests and ordinary Go
// builds remain independent of a locally downloaded framework.
@interface NSObject (JournalistSparkle)
- (id)initWithStartingUpdater:(BOOL)start updaterDelegate:(id)delegate userDriverDelegate:(id)driver;
- (id)updater;
- (BOOL)startUpdater:(NSError **)error;
- (void)checkForUpdates:(id)sender;
- (BOOL)automaticallyChecksForUpdates;
- (void)setAutomaticallyChecksForUpdates:(BOOL)enabled;
@end

extern void journalistRequestUpdateQuit(void);
extern void journalistUpdateFailed(void);
static id controller;
static void (^resumeInstall)(void);
static void (^immediateInstall)(void);
static BOOL pendingUpdate;

@interface JournalistUpdaterDelegate : NSObject
@end
@implementation JournalistUpdaterDelegate
- (BOOL)updater:(id)updater shouldPostponeRelaunchForUpdate:(id)item untilInvokingBlock:(void (^)(void))handler {
    [resumeInstall release];
    resumeInstall = [handler copy];
    pendingUpdate = YES;
    journalistRequestUpdateQuit();
    return YES;
}
- (BOOL)updater:(id)updater willInstallUpdateOnQuit:(id)item immediateInstallationBlock:(void (^)(void))handler {
    [immediateInstall release];
    immediateInstall = [handler copy];
    pendingUpdate = YES;
    return YES;
}
- (void)updater:(id)updater willInstallUpdate:(id)item { pendingUpdate = YES; }
- (void)updater:(id)updater didAbortWithError:(NSError *)error {
    NSLog(@"Journalist Mode update: %@", error.localizedDescription);
    if (pendingUpdate) {
        pendingUpdate = NO;
        [resumeInstall release]; resumeInstall = nil;
        [immediateInstall release]; immediateInstall = nil;
        journalistUpdateFailed();
    }
}
@end
static JournalistUpdaterDelegate *updateDelegate;

char *jm_start_updates(void) {
    if (controller) return NULL;
    NSString *path = [NSBundle.mainBundle.privateFrameworksPath stringByAppendingPathComponent:@"Sparkle.framework"];
    NSError *error = nil;
    NSBundle *framework = [NSBundle bundleWithPath:path];
    if (!framework || ![framework loadAndReturnError:&error]) {
        return strdup((error.localizedDescription ?: @"Updates require a packaged Journalist Mode app.").UTF8String);
    }
    Class updaterClass = NSClassFromString(@"SPUStandardUpdaterController");
    if (!updaterClass) return strdup("The update framework could not be loaded.");
    updateDelegate = [JournalistUpdaterDelegate new];
    controller = [[updaterClass alloc] initWithStartingUpdater:NO updaterDelegate:updateDelegate userDriverDelegate:nil];
    if (![[controller updater] startUpdater:&error]) {
        [controller release]; controller = nil;
        return strdup((error.localizedDescription ?: @"The updater could not start.").UTF8String);
    }
    return NULL;
}

int jm_automatic_checks(void) { return [[controller updater] automaticallyChecksForUpdates]; }
void jm_set_automatic_checks(int enabled) { [[controller updater] setAutomaticallyChecksForUpdates:enabled != 0]; }
int jm_update_pending(void) { return pendingUpdate; }
int jm_resume_update(void) {
    void (^handler)(void) = resumeInstall ?: immediateInstall;
    if (!handler) return 0;
    handler();
    return 1;
}
void jm_check_updates(void) {
    if (pendingUpdate && (resumeInstall || immediateInstall)) {
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"An update is ready to install";
        alert.informativeText = @"Install the downloaded update and relaunch Journalist Mode now? Your journal windows will ask you to save any unsaved changes.";
        [alert addButtonWithTitle:@"Install and Relaunch"];
        [alert addButtonWithTitle:@"Later"];
        NSModalResponse choice = [alert runModal];
        [alert release];
        if (choice == NSAlertFirstButtonReturn) journalistRequestUpdateQuit();
    } else if (controller) {
        [controller checkForUpdates:nil];
    } else {
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"Updates are unavailable in this build";
        alert.informativeText = @"Install the packaged Journalist Mode app to check for updates.";
        [alert runModal];
        [alert release];
    }
}
