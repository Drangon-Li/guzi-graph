#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <signal.h>
#include <unistd.h>

static void Emit(NSDictionary *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:NULL];
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    const uint8_t *bytes = line.bytes;
    NSUInteger remaining = line.length;
    while (remaining > 0) {
        ssize_t count = write(STDOUT_FILENO, bytes, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        bytes += count;
        remaining -= count;
    }
}

@interface GuziUpdater : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic) SPUUpdater *updater;
@property(nonatomic, copy) NSString *mode;
@property(nonatomic, copy) NSString *feed;
@property(nonatomic) SUAppcastItem *item;
@property(nonatomic, copy) void (^cancellation)(void);
@property(nonatomic, copy) void (^installationReply)(SPUUserUpdateChoice);
@property(nonatomic) BOOL cancelled;
@property(nonatomic) BOOL installationApproved;
@property(nonatomic) BOOL failed;
@property(nonatomic) uint64_t receivedBytes;
@property(nonatomic) uint64_t totalBytes;
@property(nonatomic) NSInteger lastPercent;
@property(nonatomic) dispatch_source_t inputSource;
@property(nonatomic) NSMutableData *input;
@property(nonatomic) NSMutableArray *signalSources;
- (void)cancel;
- (void)startWithBundle:(NSBundle *)bundle;
@end

@implementation GuziUpdater
- (void)finish:(NSString *)status {
    Emit(@{@"event": @"done", @"status": status});
    exit([status isEqualToString:@"error"] ? EXIT_FAILURE : EXIT_SUCCESS);
}
- (void)reportError:(NSError *)error {
    if (self.failed || self.cancelled) return;
    self.failed = YES;
    Emit(@{@"event": @"error", @"code": @(error.code), @"domain": error.domain,
           @"message": error.localizedDescription});
}
- (NSDictionary *)versionEvent:(NSString *)event {
    return @{@"event": event, @"version": self.item.versionString ?: @"",
             @"displayVersion": self.item.displayVersionString ?: self.item.versionString ?: @""};
}
- (void)cancel {
    if (self.installationApproved) return;
    self.cancelled = YES;
    if (self.installationReply != nil) {
        void (^reply)(SPUUserUpdateChoice) = self.installationReply;
        self.installationReply = nil;
        reply(SPUUserUpdateChoiceSkip);
    } else if (self.cancellation != nil) {
        void (^cancellation)(void) = self.cancellation;
        self.cancellation = nil;
        cancellation();
    }
}
- (void)handleCommand:(NSDictionary *)command {
    if ([command[@"command"] isEqual:@"cancel"]) {
        [self cancel];
    } else if ([command[@"command"] isEqual:@"install"] && self.installationReply != nil && !self.cancelled) {
        self.installationApproved = YES;
        void (^reply)(SPUUserUpdateChoice) = self.installationReply;
        self.installationReply = nil;
        // The parent must receive this acknowledgement before allowing the host to quit.
        Emit([self versionEvent:@"installing"]);
        reply(SPUUserUpdateChoiceInstall);
    }
}
- (void)readInput {
    uint8_t buffer[4096];
    ssize_t length = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (length <= 0) {
        if (length < 0 && errno == EINTR) return;
        dispatch_source_cancel(self.inputSource);
        [self cancel];
        return;
    }
    [self.input appendBytes:buffer length:(NSUInteger)length];
    while (YES) {
        NSRange newline = [self.input rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, self.input.length)];
        if (newline.location == NSNotFound) break;
        NSData *line = [self.input subdataWithRange:NSMakeRange(0, newline.location)];
        [self.input replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
        id command = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
        if ([command isKindOfClass:[NSDictionary class]]) [self handleCommand:command];
    }
    if (self.input.length > 16384) [self cancel];
}
- (void)startWithBundle:(NSBundle *)bundle {
    self.input = [NSMutableData data];
    self.signalSources = [NSMutableArray array];
    self.inputSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.inputSource, ^{ [self readInput]; });
    dispatch_resume(self.inputSource);
    for (NSNumber *number in @[@(SIGTERM), @(SIGINT), @(SIGHUP)]) {
        int value = number.intValue;
        signal(value, SIG_IGN);
        dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, value, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(source, ^{ [self cancel]; });
        [self.signalSources addObject:source];
        dispatch_resume(source);
    }
    self.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:self delegate:self];
    NSError *error = nil;
    if (![self.updater startUpdater:&error]) {
        [self reportError:error];
        [self finish:@"error"];
    }
    Emit(@{@"event": @"checking"});
    if ([self.mode isEqualToString:@"check"]) [self.updater checkForUpdateInformation];
    else [self.updater checkForUpdates];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feed; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
    self.item = item;
    if (!self.cancelled) Emit([self versionEvent:@"available"]);
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    if (check == SPUUpdateCheckUpdateInformation) return YES;
    if (!self.cancelled && !item.informationOnlyUpdate && [item.installationType isEqualToString:@"application"]) return YES;
    if (error != NULL) *error = [NSError errorWithDomain:@"GuziUpdater" code:1 userInfo:@{NSLocalizedDescriptionKey: @"This update cannot be installed as an application update."}];
    return NO;
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (self.cancelled) {
        Emit(@{@"event": @"cancelled"});
        [self finish:@"cancelled"];
    }
    if ([error.domain isEqualToString:SUSparkleErrorDomain] && error.code == SUNoUpdateError) {
        Emit(@{@"event": @"up-to-date"});
        [self finish:@"up-to-date"];
    }
    if (error != nil) [self reportError:error];
    [self finish:self.failed ? @"error" : (self.installationApproved ? @"installed" : @"available")];
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
    self.cancellation = cancellation;
    if (self.cancelled) [self cancel];
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    self.item = item;
    self.cancellation = nil;
    if (state.stage == SPUUserUpdateStageInstalling) {
        [self showReadyToInstallAndRelaunch:reply];
    } else {
        // Dismiss before installation never records a skipped version.
        reply(self.cancelled ? SPUUserUpdateChoiceDismiss : SPUUserUpdateChoiceInstall);
    }
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    [self reportError:error];
    acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
    self.cancellation = cancellation;
    self.lastPercent = -1;
    if (self.cancelled) [self cancel];
    else Emit(@{@"event": @"downloading", @"progress": @0, @"receivedBytes": @0, @"totalBytes": @0});
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length {
    self.receivedBytes = 0;
    self.totalBytes = length;
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    self.receivedBytes += length;
    double progress = self.totalBytes > 0 ? MIN(1.0, (double)self.receivedBytes / self.totalBytes) : 0;
    NSInteger percent = (NSInteger)(progress * 100);
    if (percent != self.lastPercent && !self.cancelled) {
        self.lastPercent = percent;
        Emit(@{@"event": @"downloading", @"progress": @(progress), @"receivedBytes": @(self.receivedBytes), @"totalBytes": @(self.totalBytes)});
    }
}
- (void)showDownloadDidStartExtractingUpdate { self.cancellation = nil; }
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    self.cancellation = nil;
    self.installationReply = reply;
    if (self.cancelled) [self cancel];
    else Emit([self versionEvent:@"downloaded"]);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); }
- (void)dismissUpdateInstallation { self.cancellation = nil; self.installationReply = nil; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        NSMutableDictionary *arguments = [NSMutableDictionary dictionary];
        if (argc == 7) for (int index = 1; index + 1 < argc; index += 2) arguments[@(argv[index])] = @(argv[index + 1]);
        NSString *mode = arguments[@"--mode"];
        NSString *host = arguments[@"--host"];
        NSURL *feed = [NSURL URLWithString:arguments[@"--feed"] ?: @""];
        NSBundle *bundle = host.isAbsolutePath ? [NSBundle bundleWithPath:host] : nil;
        BOOL loopback = [@[@"127.0.0.1", @"localhost", @"::1", @"[::1]"] containsObject:feed.host];
        BOOL validFeed = [feed.scheme isEqualToString:@"https"] || ([feed.scheme isEqualToString:@"http"] && loopback);
        if ((![@[@"check", @"download"] containsObject:mode]) || bundle.bundleIdentifier == nil || !validFeed || feed.host.length == 0) {
            Emit(@{@"event": @"error", @"code": @1, @"message": @"Expected --mode check|download --host /absolute/Application.app --feed https://host/appcast.xml"});
            Emit(@{@"event": @"done", @"status": @"error"});
            return EXIT_FAILURE;
        }
        [NSApplication sharedApplication];
        GuziUpdater *driver = [GuziUpdater new];
        driver.mode = mode;
        driver.feed = feed.absoluteString;
        [driver startWithBundle:bundle];
        [[NSRunLoop currentRunLoop] run];
    }
    return EXIT_SUCCESS;
}
