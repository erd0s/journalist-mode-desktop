#import <Cocoa/Cocoa.h>
#import <dlfcn.h>

extern void journalistDesktopSnapshot(char *json, int baseline);

typedef int CGSConnectionID;
static CGSConnectionID (*jm_SLSMainConnectionID)(void);
static CFArrayRef (*jm_SLSCopyManagedDisplaySpaces)(CGSConnectionID);
static BOOL desktopMonitorStarted;

// The package builds without ARC, so every allocation here is released or
// autoreleased and callers run inside an autorelease pool.
static char *jm_json_string(NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    return strdup(text.UTF8String);
}

static char *jm_json_error(NSString *reason) {
    return jm_json_string(@{@"error": reason});
}

// jm_desktop_snapshot serialises the live SLSCopyManagedDisplaySpaces array.
// It uses no AppKit state, so any thread may call it.
char *jm_desktop_snapshot(void) {
    @autoreleasepool {
        if (!jm_SLSMainConnectionID || !jm_SLSCopyManagedDisplaySpaces) {
            return jm_json_error(@"SkyLight symbols are not loaded");
        }
        CFArrayRef spaces = jm_SLSCopyManagedDisplaySpaces(jm_SLSMainConnectionID());
        if (!spaces) {
            return jm_json_error(@"SLSCopyManagedDisplaySpaces returned no data");
        }
        NSDictionary *payload = @{@"displays": CFBridgingRelease(spaces)};
        if (![NSJSONSerialization isValidJSONObject:payload]) {
            return jm_json_error(@"SLSCopyManagedDisplaySpaces returned values that cannot be serialised");
        }
        return jm_json_string(payload);
    }
}

static void jm_publish_desktop_snapshot(int baseline) {
    char *json = jm_desktop_snapshot();
    journalistDesktopSnapshot(json, baseline);
    free(json);
}

char *jm_start_desktop_monitor(void) {
    if (desktopMonitorStarted) return NULL;
    void *handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW);
    if (!handle) return strdup("the SkyLight framework could not be loaded");
    jm_SLSMainConnectionID = dlsym(handle, "SLSMainConnectionID");
    jm_SLSCopyManagedDisplaySpaces = dlsym(handle, "SLSCopyManagedDisplaySpaces");
    if (!jm_SLSMainConnectionID) return strdup("SkyLight does not export SLSMainConnectionID");
    if (!jm_SLSCopyManagedDisplaySpaces) return strdup("SkyLight does not export SLSCopyManagedDisplaySpaces");
    desktopMonitorStarted = YES;
    // Space changes are posted on the workspace notification centre, not the
    // default one. Wake notifications live there too.
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    [workspace addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        jm_publish_desktop_snapshot(0);
    }];
    // Waking, and displays coming or going, re-baseline: the desktop may
    // differ from the one seen before sleep without the user switching.
    for (NSNotificationName name in @[NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidWakeNotification]) {
        [workspace addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) {
            jm_publish_desktop_snapshot(1);
        }];
    }
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        jm_publish_desktop_snapshot(1);
    }];
    return NULL;
}
