#include <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <zlib.h>

#define GIT_FD 3
#define OBJECTS_FD 4
#define REFS_FD 5
#define LOGS_FD 6
#define QUARANTINE_FD 7
#define MAX_OBJECTS 256U
#define MAX_BRANCH 512U
#define MAX_ACTOR 256U
#define MAX_MESSAGE 1024U
#define MAX_REQUEST 13000U
#define MAX_COMPRESSED (64U * 1024U * 1024U)
#define MAX_INFLATED (64U * 1024U * 1024U)
#define MAX_REFLOG (16U * 1024U * 1024U)
#define FLAG_REFLOG 1U

enum { NO_EFFECT = 0, OBJECTS_INSTALLED = 1, REF_UPDATED = 2, UNCERTAIN = 3 };
enum {
  DETAIL_OK = 0, DETAIL_PROTOCOL = 1, DETAIL_AUTHORITY = 2, DETAIL_UNSUPPORTED = 3,
  DETAIL_CORRUPT_OBJECT = 4, DETAIL_REF_MISMATCH = 5, DETAIL_LOCK_COLLISION = 6,
  DETAIL_UNSAFE_ANCESTRY = 7, DETAIL_IO_NO_EFFECT = 8, DETAIL_ORPHAN_OBJECTS = 9,
  DETAIL_PUBLICATION_UNCERTAIN = 10
};

typedef struct {
  uint8_t format;
  size_t oid_length;
  uint16_t flags;
  uint16_t object_count;
  char branch[MAX_BRANCH + 1U];
  size_t branch_length;
  char actor[MAX_ACTOR + 1U];
  size_t actor_length;
  char message[MAX_MESSAGE + 1U];
  size_t message_length;
  uint8_t old_oid[32];
  uint8_t new_oid[32];
  uint8_t object_oids[MAX_OBJECTS][32];
} request_t;

static int write_result(uint8_t status, uint8_t detail, const request_t *request);
static int read_request(request_t *request);
static int validate_authority(const request_t *request);
static int install_object(const request_t *request, const uint8_t *oid, int *created);
static int verify_target_commit(const request_t *request);
static int update_ref(const request_t *request);
static int publish_reflog(const request_t *request);
static int open_branch_parent(int root, const char *branch, int *parent, char leaf[MAX_BRANCH + 1U]);
static int verify_loose_object(int fd, const request_t *request, const uint8_t *expected, int require_commit);
static int digest_stream(int fd, const request_t *request, uint8_t output[32], int require_commit);
static int copy_all(int from, int to);
static int copy_exact(int from, int to, size_t length);
static int valid_directory_fd(int fd);
static int descriptor_matches_path(int root, const char *first, const char *second, const char *third, int expected);
static int canonical_header(const uint8_t *header, size_t length, uint64_t payload_size, int require_commit);
static int valid_text(const char *text, size_t length);
static int valid_branch(const char *branch, size_t length);
static void oid_hex(const uint8_t *oid, size_t length, char output[65]);
static int parse_hex_oid(const char *hex, size_t length, uint8_t output[32]);
static uint16_t be16(const uint8_t *bytes);

int main(int argc, char **argv) {
  (void)argv;
  request_t request = {0};
  if (argc != 1) return write_result(NO_EFFECT, DETAIL_PROTOCOL, &request);
  if (read_request(&request) != 0) return write_result(NO_EFFECT, DETAIL_PROTOCOL, &request);
  if (validate_authority(&request) != 0) return write_result(NO_EFFECT, DETAIL_AUTHORITY, &request);

  int installed = 0;
  int target_declared = 0;
  for (uint16_t index = 0; index < request.object_count; index++) {
    if (memcmp(request.object_oids[index], request.new_oid, request.oid_length) == 0) target_declared = 1;
    int created = 0;
    const int result = install_object(&request, request.object_oids[index], &created);
    if (result == DETAIL_PUBLICATION_UNCERTAIN) return write_result(UNCERTAIN, DETAIL_PUBLICATION_UNCERTAIN, &request);
    if (result == DETAIL_CORRUPT_OBJECT) {
      return write_result(installed ? OBJECTS_INSTALLED : NO_EFFECT, installed ? DETAIL_ORPHAN_OBJECTS : DETAIL_CORRUPT_OBJECT, &request);
    }
    if (result != DETAIL_OK) {
      return write_result(installed ? OBJECTS_INSTALLED : NO_EFFECT, installed ? DETAIL_ORPHAN_OBJECTS : DETAIL_IO_NO_EFFECT, &request);
    }
    installed |= created;
  }
  if (!target_declared || verify_target_commit(&request) != 0) {
    return write_result(installed ? OBJECTS_INSTALLED : NO_EFFECT,
      installed ? DETAIL_ORPHAN_OBJECTS : DETAIL_CORRUPT_OBJECT, &request);
  }
  const int ref_result = update_ref(&request);
  if (ref_result == DETAIL_OK) return write_result(REF_UPDATED, DETAIL_OK, &request);
  if (ref_result == DETAIL_PUBLICATION_UNCERTAIN) return write_result(UNCERTAIN, DETAIL_PUBLICATION_UNCERTAIN, &request);
  return write_result(installed ? OBJECTS_INSTALLED : NO_EFFECT, installed ? DETAIL_ORPHAN_OBJECTS : (uint8_t)ref_result, &request);
}

static int read_request(request_t *request) {
  uint8_t bytes[MAX_REQUEST + 1U];
  size_t length = 0;
  while (length <= MAX_REQUEST) {
    const ssize_t count = read(STDIN_FILENO, bytes + length, sizeof(bytes) - length);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return -1;
    if (count == 0) break;
    length += (size_t)count;
  }
  if (length > MAX_REQUEST || length < 22U || memcmp(bytes, "ASTRGC01", 8U) != 0 ||
      be16(bytes + 8U) != 1U || bytes[13] != 0U) return -1;
  request->flags = be16(bytes + 10U);
  request->format = bytes[12];
  request->oid_length = request->format == 1U ? 20U : request->format == 2U ? 32U : 0U;
  if (request->oid_length == 0U || (request->flags & ~FLAG_REFLOG) != 0U) return -1;
  request->object_count = be16(bytes + 14U);
  request->branch_length = be16(bytes + 16U);
  request->actor_length = be16(bytes + 18U);
  request->message_length = be16(bytes + 20U);
  if (request->object_count > MAX_OBJECTS || request->branch_length == 0U ||
      request->branch_length > MAX_BRANCH || request->actor_length > MAX_ACTOR || request->message_length > MAX_MESSAGE) return -1;
  const size_t expected = 22U + (2U + request->object_count) * request->oid_length +
    request->branch_length + request->actor_length + request->message_length;
  if (length != expected) return -1;
  size_t offset = 22U;
  memcpy(request->old_oid, bytes + offset, request->oid_length); offset += request->oid_length;
  memcpy(request->new_oid, bytes + offset, request->oid_length); offset += request->oid_length;
  memcpy(request->branch, bytes + offset, request->branch_length); offset += request->branch_length;
  memcpy(request->actor, bytes + offset, request->actor_length); offset += request->actor_length;
  memcpy(request->message, bytes + offset, request->message_length); offset += request->message_length;
  for (uint16_t index = 0; index < request->object_count; index++) {
    memcpy(request->object_oids[index], bytes + offset, request->oid_length);
    offset += request->oid_length;
  }
  return valid_branch(request->branch, request->branch_length) && valid_text(request->actor, request->actor_length) &&
    valid_text(request->message, request->message_length) &&
    (((request->flags & FLAG_REFLOG) == 0U && request->actor_length == 0U && request->message_length == 0U) ||
     ((request->flags & FLAG_REFLOG) != 0U && request->actor_length != 0U)) ? 0 : -1;
}

static int validate_authority(const request_t *request) {
  if (!valid_directory_fd(GIT_FD) || !valid_directory_fd(OBJECTS_FD) || !valid_directory_fd(REFS_FD) ||
      !valid_directory_fd(QUARANTINE_FD)) return -1;
  if ((request->flags & FLAG_REFLOG) != 0U && !valid_directory_fd(LOGS_FD)) return -1;
  if (!descriptor_matches_path(GIT_FD, "objects", NULL, NULL, OBJECTS_FD) ||
      !descriptor_matches_path(GIT_FD, "refs", "heads", NULL, REFS_FD)) return -1;
  if ((request->flags & FLAG_REFLOG) != 0U &&
      !descriptor_matches_path(GIT_FD, "logs", "refs", "heads", LOGS_FD)) return -1;
  return 0;
}

static int install_object(const request_t *request, const uint8_t *oid, int *created) {
  char hex[65]; oid_hex(oid, request->oid_length, hex);
  char fanout[3] = {hex[0], hex[1], 0};
  const char *leaf = hex + 2;
  const int source_dir = openat(QUARANTINE_FD, fanout, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source_dir < 0) return DETAIL_CORRUPT_OBJECT;
  const int source = openat(source_dir, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0 || verify_loose_object(source, request, oid, 0) != 0) {
    if (source >= 0) close(source);
    close(source_dir); return DETAIL_CORRUPT_OBJECT;
  }
  int fanout_created = 0;
  if (mkdirat(OBJECTS_FD, fanout, 0777) == 0) fanout_created = 1;
  else if (errno != EEXIST) { close(source); close(source_dir); return DETAIL_IO_NO_EFFECT; }
  const int destination_dir = openat(OBJECTS_FD, fanout, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (destination_dir < 0) { close(source); close(source_dir); return DETAIL_IO_NO_EFFECT; }
  const int existing = openat(destination_dir, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (existing >= 0) {
    const int ok = verify_loose_object(existing, request, oid, 0);
    close(existing); close(destination_dir); close(source); close(source_dir);
    return ok == 0 ? DETAIL_OK : DETAIL_CORRUPT_OBJECT;
  }
  if (errno != ENOENT) { close(destination_dir); close(source); close(source_dir); return DETAIL_IO_NO_EFFECT; }
  char temporary[96];
  const int written = snprintf(temporary, sizeof(temporary), ".astra-%ld-%08x", (long)getpid(), arc4random());
  if (written < 0 || (size_t)written >= sizeof(temporary)) { close(destination_dir); close(source); close(source_dir); return DETAIL_IO_NO_EFFECT; }
  const int output = openat(destination_dir, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0444);
  if (output < 0) { close(destination_dir); close(source); close(source_dir); return DETAIL_IO_NO_EFFECT; }
  if (lseek(source, 0, SEEK_SET) < 0 || copy_all(source, output) != 0 || fsync(output) != 0 ||
      verify_loose_object(output, request, oid, 0) != 0) {
    close(output); unlinkat(destination_dir, temporary, 0); close(destination_dir); close(source); close(source_dir); return DETAIL_IO_NO_EFFECT;
  }
  if (close(output) != 0 || linkat(destination_dir, temporary, destination_dir, leaf, 0) != 0) {
    unlinkat(destination_dir, temporary, 0); close(destination_dir); close(source); close(source_dir); return DETAIL_IO_NO_EFFECT;
  }
  *created = 1;
  if (unlinkat(destination_dir, temporary, 0) != 0 || fsync(destination_dir) != 0 ||
      (fanout_created && fsync(OBJECTS_FD) != 0)) {
    close(destination_dir); close(source); close(source_dir); return DETAIL_PUBLICATION_UNCERTAIN;
  }
  close(destination_dir); close(source); close(source_dir); *created = 1; return DETAIL_OK;
}

static int verify_target_commit(const request_t *request) {
  char hex[65]; oid_hex(request->new_oid, request->oid_length, hex);
  char fanout[3] = {hex[0], hex[1], 0};
  const int directory = openat(OBJECTS_FD, fanout, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) return -1;
  const int object = openat(directory, hex + 2, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  const int result = object < 0 ? -1 : verify_loose_object(object, request, request->new_oid, 1);
  if (object >= 0) close(object);
  close(directory);
  return result;
}

static int update_ref(const request_t *request) {
  int ref_parent = -1; char leaf[MAX_BRANCH + 1U];
  if (open_branch_parent(REFS_FD, request->branch, &ref_parent, leaf) != 0) return DETAIL_UNSAFE_ANCESTRY;
  char lock[sizeof(leaf)];
  if (snprintf(lock, sizeof(lock), "%s.lock", leaf) < 0 || strlen(lock) >= sizeof(lock)) { close(ref_parent); return DETAIL_UNSAFE_ANCESTRY; }
  const int lock_fd = openat(ref_parent, lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
  if (lock_fd < 0) { close(ref_parent); return errno == EEXIST ? DETAIL_LOCK_COLLISION : DETAIL_IO_NO_EFFECT; }
  int result = DETAIL_IO_NO_EFFECT;
  const int current = openat(ref_parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  struct stat ref_metadata;
  uint8_t raw[66]; const ssize_t count = current < 0 || fstat(current, &ref_metadata) != 0 || !S_ISREG(ref_metadata.st_mode)
    ? -1 : read(current, raw, sizeof(raw));
  if (current >= 0) close(current);
  uint8_t parsed[32];
  if (count != (ssize_t)(request->oid_length * 2U + 1U) || raw[(size_t)count - 1U] != '\n' ||
      parse_hex_oid((const char *)raw, request->oid_length * 2U, parsed) != 0 ||
      memcmp(parsed, request->old_oid, request->oid_length) != 0) { result = DETAIL_REF_MISMATCH; goto cleanup; }
  char new_hex[65]; oid_hex(request->new_oid, request->oid_length, new_hex);
  if (write(lock_fd, new_hex, request->oid_length * 2U) != (ssize_t)(request->oid_length * 2U) ||
      write(lock_fd, "\n", 1U) != 1 || fsync(lock_fd) != 0) { goto cleanup; }
  if (close(lock_fd) != 0) { goto cleanup_closed; }

  if ((request->flags & FLAG_REFLOG) != 0U) {
    const int log_result = publish_reflog(request);
    if (log_result != DETAIL_OK) {
      const int removed = unlinkat(ref_parent, lock, 0);
      close(ref_parent);
      return removed == 0 ? log_result : DETAIL_PUBLICATION_UNCERTAIN;
    }
  }
  if (renameat(ref_parent, lock, ref_parent, leaf) != 0 || fsync(ref_parent) != 0) { close(ref_parent); return DETAIL_PUBLICATION_UNCERTAIN; }
  close(ref_parent); return DETAIL_OK;
cleanup:
  close(lock_fd);
cleanup_closed:
  if (unlinkat(ref_parent, lock, 0) != 0) result = DETAIL_PUBLICATION_UNCERTAIN;
  close(ref_parent); return result;
}

static int publish_reflog(const request_t *request) {
  int parent = -1; char leaf[MAX_BRANCH + 1U];
  if (open_branch_parent(LOGS_FD, request->branch, &parent, leaf) != 0) return DETAIL_UNSAFE_ANCESTRY;
  char lock[MAX_BRANCH + 1U];
  if (snprintf(lock, sizeof(lock), "%s.lock", leaf) < 0 || strlen(lock) >= sizeof(lock)) { close(parent); return DETAIL_UNSAFE_ANCESTRY; }
  const int output = openat(parent, lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
  if (output < 0) { close(parent); return errno == EEXIST ? DETAIL_LOCK_COLLISION : DETAIL_IO_NO_EFFECT; }
  const int existing = openat(parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  struct stat log_metadata;
  int ok = existing >= 0 && fstat(existing, &log_metadata) == 0 && S_ISREG(log_metadata.st_mode) &&
    log_metadata.st_size >= 0 && (uint64_t)log_metadata.st_size <= MAX_REFLOG &&
    copy_exact(existing, output, (size_t)log_metadata.st_size) == 0;
  if (existing >= 0) close(existing);
  char old_hex[65]; char new_hex[65]; oid_hex(request->old_oid, request->oid_length, old_hex); oid_hex(request->new_oid, request->oid_length, new_hex);
  const size_t length = request->oid_length * 4U + 4U + request->actor_length + request->message_length;
  char *entry = malloc(length);
  if (entry == NULL) ok = 0;
  if (entry != NULL) {
    size_t offset = 0; memcpy(entry + offset, old_hex, request->oid_length * 2U); offset += request->oid_length * 2U;
    entry[offset++] = ' '; memcpy(entry + offset, new_hex, request->oid_length * 2U); offset += request->oid_length * 2U;
    entry[offset++] = ' '; memcpy(entry + offset, request->actor, request->actor_length); offset += request->actor_length;
    entry[offset++] = '\t'; memcpy(entry + offset, request->message, request->message_length); offset += request->message_length; entry[offset++] = '\n';
    if (!ok || write(output, entry, offset) != (ssize_t)offset || fsync(output) != 0) ok = 0;
    free(entry);
  }
  if (close(output) != 0) ok = 0;
  if (!ok) {
    const int removed = unlinkat(parent, lock, 0); close(parent);
    return removed == 0 ? DETAIL_IO_NO_EFFECT : DETAIL_PUBLICATION_UNCERTAIN;
  }
  if (renameat(parent, lock, parent, leaf) != 0) {
    const int removed = unlinkat(parent, lock, 0); close(parent);
    return removed == 0 ? DETAIL_IO_NO_EFFECT : DETAIL_PUBLICATION_UNCERTAIN;
  }
  if (fsync(parent) != 0) { close(parent); return DETAIL_PUBLICATION_UNCERTAIN; }
  close(parent); return DETAIL_OK;
}

static int open_branch_parent(int root, const char *branch, int *parent, char leaf[MAX_BRANCH + 1U]) {
  char path[MAX_BRANCH + 1U]; memcpy(path, branch, strlen(branch) + 1U);
  int current = dup(root);
  if (current < 0) return -1;
  char *cursor = path;
  for (;;) {
    char *separator = strchr(cursor, '/');
    if (separator == NULL) { memcpy(leaf, cursor, strlen(cursor) + 1U); *parent = current; return 0; }
    *separator = 0;
    const int next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) return -1;
    current = next; cursor = separator + 1;
  }
}

static int verify_loose_object(int fd, const request_t *request, const uint8_t *expected, int require_commit) {
  struct stat metadata;
  if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_size <= 0 ||
      (uint64_t)metadata.st_size > MAX_COMPRESSED) return -1;
  uint8_t digest[32];
  if (digest_stream(fd, request, digest, require_commit) != 0) return -1;
  return memcmp(digest, expected, request->oid_length) == 0 ? 0 : -1;
}

static int digest_stream(int fd, const request_t *request, uint8_t output[32], int require_commit) {
  if (lseek(fd, 0, SEEK_SET) < 0) return -1;
  z_stream stream = {0};
  if (inflateInit(&stream) != Z_OK) return -1;
  CC_SHA1_CTX sha1; CC_SHA256_CTX sha256;
  if (request->format == 1U) (void)CC_SHA1_Init(&sha1); else (void)CC_SHA256_Init(&sha256);
  uint8_t input[16384]; uint8_t inflated[16384]; uint8_t header[96];
  size_t header_length = 0; uint64_t total = 0; uint64_t declared = 0; int header_complete = 0; int finished = 0;
  for (;;) {
    const ssize_t count = read(fd, input, sizeof(input));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) break;
    stream.next_in = input; stream.avail_in = (uInt)count;
    do {
      stream.next_out = inflated; stream.avail_out = (uInt)sizeof(inflated);
      const int code = inflate(&stream, Z_NO_FLUSH);
      const size_t produced = sizeof(inflated) - stream.avail_out;
      if (produced != 0U) {
        if (total > MAX_INFLATED - produced) { inflateEnd(&stream); return -1; }
        for (size_t index = 0; index < produced && !header_complete; index++) {
          if (inflated[index] == 0U) {
            if (canonical_header(header, header_length, total + index + 1U, require_commit) != 0) { inflateEnd(&stream); return -1; }
            const uint8_t *space = memchr(header, ' ', header_length);
            if (space == NULL) { inflateEnd(&stream); return -1; }
            declared = 0;
            for (const uint8_t *digit = space + 1; digit < header + header_length; digit++) {
              if (*digit < '0' || *digit > '9' || declared > (UINT64_MAX - (*digit - '0')) / 10U) { inflateEnd(&stream); return -1; }
              declared = declared * 10U + (*digit - '0');
            }
            header_complete = 1;
          } else {
            if (header_length >= sizeof(header)) { inflateEnd(&stream); return -1; }
            header[header_length++] = inflated[index];
          }
        }
        total += produced;
        if (request->format == 1U) (void)CC_SHA1_Update(&sha1, inflated, (CC_LONG)produced);
        else (void)CC_SHA256_Update(&sha256, inflated, (CC_LONG)produced);
      }
      if (code == Z_STREAM_END) { finished = 1; break; }
      if (code != Z_OK) { inflateEnd(&stream); return -1; }
    } while (stream.avail_in != 0U || stream.avail_out == 0U);
    if (finished) {
      if (stream.avail_in != 0U) { inflateEnd(&stream); return -1; }
      uint8_t trailing;
      if (read(fd, &trailing, 1U) != 0) { inflateEnd(&stream); return -1; }
      break;
    }
    if (count == 0) break;
  }
  inflateEnd(&stream);
  if (!finished || !header_complete || total != (uint64_t)header_length + 1U + declared) return -1;
  if (request->format == 1U) (void)CC_SHA1_Final(output, &sha1); else (void)CC_SHA256_Final(output, &sha256);
  return 0;
}

static int copy_all(int from, int to) {
  uint8_t bytes[16384];
  for (;;) {
    const ssize_t count = read(from, bytes, sizeof(bytes));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return -1;
    if (count == 0) return 0;
    size_t offset = 0;
    while (offset < (size_t)count) {
      const ssize_t written = write(to, bytes + offset, (size_t)count - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) return -1;
      offset += (size_t)written;
    }
  }
}

static int copy_exact(int from, int to, size_t length) {
  uint8_t bytes[16384];
  size_t remaining = length;
  while (remaining != 0U) {
    const size_t wanted = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
    const ssize_t count = read(from, bytes, wanted);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    size_t offset = 0;
    while (offset < (size_t)count) {
      const ssize_t written = write(to, bytes + offset, (size_t)count - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) return -1;
      offset += (size_t)written;
    }
    remaining -= (size_t)count;
  }
  uint8_t trailing;
  const ssize_t extra = read(from, &trailing, 1U);
  return extra == 0 ? 0 : -1;
}

static int valid_directory_fd(int fd) {
  struct stat metadata; const int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY && fstat(fd, &metadata) == 0 && S_ISDIR(metadata.st_mode);
}

static int descriptor_matches_path(int root, const char *first, const char *second, const char *third, int expected) {
  const char *components[3] = {first, second, third};
  int current = dup(root);
  if (current < 0) return 0;
  for (size_t index = 0; index < 3U && components[index] != NULL; index++) {
    const int next = openat(current, components[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) return 0;
    current = next;
  }
  struct stat actual; struct stat supplied;
  const int matches = fstat(current, &actual) == 0 && fstat(expected, &supplied) == 0 &&
    actual.st_dev == supplied.st_dev && actual.st_ino == supplied.st_ino;
  close(current);
  return matches;
}

static int canonical_header(const uint8_t *header, size_t length, uint64_t header_end, int require_commit) {
  (void)header_end;
  const uint8_t *space = memchr(header, ' ', length);
  if (space == NULL || space == header || space + 1 >= header + length) return -1;
  const size_t type_length = (size_t)(space - header);
  const int known = (type_length == 4U && memcmp(header, "blob", 4U) == 0) ||
    (type_length == 4U && memcmp(header, "tree", 4U) == 0) ||
    (type_length == 6U && memcmp(header, "commit", 6U) == 0) ||
    (type_length == 3U && memcmp(header, "tag", 3U) == 0);
  if (!known || (require_commit && (type_length != 6U || memcmp(header, "commit", 6U) != 0))) return -1;
  const size_t digits = length - type_length - 1U;
  if (digits > 1U && space[1] == '0') return -1;
  for (size_t index = 1U; index <= digits; index++) if (space[index] < '0' || space[index] > '9') return -1;
  return 0;
}

static int valid_text(const char *text, size_t length) {
  for (size_t index = 0; index < length; index++) {
    const unsigned char byte = (unsigned char)text[index];
    if (byte == 0U || byte == '\r' || byte == '\n') return 0;
  }
  return 1;
}

static int valid_branch(const char *branch, size_t length) {
  if (!valid_text(branch, length) || branch[0] == '/' || branch[length - 1U] == '/' || strstr(branch, "//") != NULL) return 0;
  size_t start = 0;
  for (size_t index = 0; index <= length; index++) {
    if (index != length && branch[index] != '/') {
      const unsigned char byte = (unsigned char)branch[index];
      if (byte < 0x20U || byte == 0x7fU || byte == '\\') return 0;
      continue;
    }
    const size_t component = index - start;
    if (component == 0U || (component == 1U && branch[start] == '.') ||
        (component == 2U && branch[start] == '.' && branch[start + 1U] == '.') ||
        (component >= 5U && memcmp(branch + index - 5U, ".lock", 5U) == 0)) return 0;
    start = index + 1U;
  }
  return 1;
}

static void oid_hex(const uint8_t *oid, size_t length, char output[65]) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0; index < length; index++) {
    output[index * 2U] = alphabet[oid[index] >> 4U];
    output[index * 2U + 1U] = alphabet[oid[index] & 15U];
  }
  output[length * 2U] = 0;
}

static int parse_hex_oid(const char *hex, size_t length, uint8_t output[32]) {
  for (size_t index = 0; index < length / 2U; index++) {
    const char high = hex[index * 2U]; const char low = hex[index * 2U + 1U];
    const int h = high >= '0' && high <= '9' ? high - '0' : high >= 'a' && high <= 'f' ? high - 'a' + 10 : -1;
    const int l = low >= '0' && low <= '9' ? low - '0' : low >= 'a' && low <= 'f' ? low - 'a' + 10 : -1;
    if (h < 0 || l < 0) return -1;
    output[index] = (uint8_t)((unsigned int)h * 16U + (unsigned int)l);
  }
  return 0;
}

static int write_result(uint8_t status, uint8_t detail, const request_t *request) {
  uint8_t response[46] = {0}; memcpy(response, "ASTRGR01", 8U); response[9] = 1U;
  response[10] = status; response[11] = detail; response[12] = request->format;
  response[13] = (uint8_t)request->oid_length;
  if (request->oid_length != 0U) memcpy(response + 14U, request->new_oid, request->oid_length);
  size_t offset = 0; const size_t length = 14U + request->oid_length;
  while (offset < length) {
    const ssize_t count = write(STDOUT_FILENO, response + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 1;
    offset += (size_t)count;
  }
  return 0;
}

static uint16_t be16(const uint8_t *bytes) { return (uint16_t)(((uint16_t)bytes[0] << 8U) | bytes[1]); }
