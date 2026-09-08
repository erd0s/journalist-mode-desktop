#import <Cocoa/Cocoa.h>

extern void journalistCommandState(int held, int used, unsigned long long sequence);
static id commandMonitor;
static BOOL commandHeld;
static BOOL commandUsed;
static BOOL suppressUntilRelease;
static unsigned long long commandSequence;

static void publishCommandState(BOOL held, BOOL used) {
    journalistCommandState(held, used, ++commandSequence);
}

static void clearCommandState(void) {
    suppressUntilRelease = (NSEvent.modifierFlags & NSEventModifierFlagCommand) != 0;
    commandHeld = NO;
    commandUsed = NO;
    publishCommandState(NO, NO);
}

void jm_start_command_monitor(void) {
    if (commandMonitor) return;
    commandMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskFlagsChanged | NSEventMaskKeyDown) handler:^NSEvent *(NSEvent *event) {
        BOOL held = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
        if (!held) {
            suppressUntilRelease = NO;
            commandHeld = NO;
            commandUsed = NO;
            publishCommandState(NO, NO);
        } else if (!suppressUntilRelease) {
            if (event.type == NSEventTypeKeyDown) commandUsed = YES;
            // The aggregate modifier flag stays set while either Command key
            // remains down. Other modifiers do not restart the hold timer.
            if (commandHeld || event.keyCode == 54 || event.keyCode == 55 || event.type == NSEventTypeKeyDown) {
                commandHeld = YES;
                publishCommandState(YES, commandUsed);
            }
        }
        return event;
    }];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *note) { clearCommandState(); }];
    [center addObserverForName:NSWindowDidResignKeyNotification object:nil queue:nil usingBlock:^(NSNotification *note) { clearCommandState(); }];
}
