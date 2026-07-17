#define _DARWIN_C_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <unistd.h>

#define WORKSPACE_FD 3
#define MAX_FILES 64U
#define MAX_FILE_BYTES (256U * 1024U)
#define MAX_TOTAL_BYTES (1024U * 1024U)
#define MAX_OUTPUT_BYTES (2U * 1024U * 1024U)
#define MAX_RELATIVE_PATH_BYTES 1024U

typedef struct {
  char path[MAX_RELATIVE_PATH_BYTES];
  size_t path_length;
  struct stat metadata;
  uint8_t digest[32];
  uint8_t *content;
  size_t content_length;
} record_t;

typedef struct {
  record_t records[MAX_FILES];
  size_t count;
  size_t total_bytes;
} inventory_t;

typedef struct {
  uint8_t *bytes;
  size_t length;
  size_t capacity;
} output_t;

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t block[64];
  size_t block_length;
} sha256_t;

static int collect_optional_file(inventory_t *inventory, int parent_fd, const char *name, const char *relative_path);
static int collect_directory(inventory_t *inventory, int parent_fd, const char *name, const char *prefix);
static int open_optional_directory(int parent_fd, const char *name, int *directory_fd, struct stat *metadata);
static int directory_stable(int parent_fd, const char *name, int directory_fd, const struct stat *expected);
static int read_stable_file(inventory_t *inventory, int parent_fd, const char *name, const char *relative_path);
static int metadata_equal(const struct stat *left, const struct stat *right);
static int private_output_socket(int descriptor);
static int validate_utf8(const uint8_t *bytes, size_t length);
static int record_compare(const void *left, const void *right);
static int append_output(output_t *output, const void *bytes, size_t length);
static int append_u16(output_t *output, uint16_t value);
static int append_u32(output_t *output, uint32_t value);
static int append_u64(output_t *output, uint64_t value);
static int encode_inventory(const inventory_t *inventory, output_t *output);
static int write_all(int descriptor, const uint8_t *bytes, size_t length);
static void free_inventory(inventory_t *inventory);
static int fail(inventory_t *inventory, output_t *output, const char *reason);
static void sha256_init(sha256_t *context);
static void sha256_update(sha256_t *context, const uint8_t *bytes, size_t length);
static void sha256_finish(sha256_t *context, uint8_t digest[32]);
static void sha256_transform(sha256_t *context, const uint8_t block[64]);

int main(int argc, char **argv) {
  (void)argv;
  inventory_t inventory = {0};
  output_t output = {0};
  struct stat workspace_metadata;
  struct stat output_metadata;

  if (argc != 1) return fail(&inventory, &output, "arguments_forbidden");
  if (fstat(STDOUT_FILENO, &output_metadata) != 0 || !S_ISSOCK(output_metadata.st_mode) ||
      !private_output_socket(STDOUT_FILENO)) {
    return fail(&inventory, &output, "private_pipe_required");
  }
  const int workspace_flags = fcntl(WORKSPACE_FD, F_GETFL);
  if (workspace_flags < 0 || (workspace_flags & O_ACCMODE) != O_RDONLY ||
      fstat(WORKSPACE_FD, &workspace_metadata) != 0 || !S_ISDIR(workspace_metadata.st_mode)) {
    return fail(&inventory, &output, "invalid_workspace_fd");
  }
  if (collect_optional_file(&inventory, WORKSPACE_FD, "opencode.json", "opencode.json") != 0) {
    return fail(&inventory, &output, "unsafe_allowlisted_file");
  }
  if (collect_optional_file(&inventory, WORKSPACE_FD, "opencode.jsonc", "opencode.jsonc") != 0) {
    return fail(&inventory, &output, "unsafe_allowlisted_file");
  }
  if (collect_optional_file(&inventory, WORKSPACE_FD, ".mcp.json", ".mcp.json") != 0) {
    return fail(&inventory, &output, "unsafe_allowlisted_file");
  }

  int opencode_fd = -1;
  struct stat opencode_metadata;
  const int opencode_status = open_optional_directory(WORKSPACE_FD, ".opencode", &opencode_fd, &opencode_metadata);
  if (opencode_status < 0) return fail(&inventory, &output, "unsafe_opencode_directory");
  if (opencode_status > 0) {
    if (collect_optional_file(&inventory, opencode_fd, "opencode.json", ".opencode/opencode.json") != 0 ||
        collect_optional_file(&inventory, opencode_fd, "opencode.jsonc", ".opencode/opencode.jsonc") != 0 ||
        collect_directory(&inventory, opencode_fd, "plugin", ".opencode/plugin/") != 0 ||
        collect_directory(&inventory, opencode_fd, "plugins", ".opencode/plugins/") != 0 ||
        !directory_stable(WORKSPACE_FD, ".opencode", opencode_fd, &opencode_metadata)) {
      (void)close(opencode_fd);
      return fail(&inventory, &output, "unsafe_opencode_entry");
    }
    if (close(opencode_fd) != 0) return fail(&inventory, &output, "directory_close_failed");
  }

  struct stat completed_workspace_metadata;
  if (fstat(WORKSPACE_FD, &completed_workspace_metadata) != 0 ||
      !metadata_equal(&workspace_metadata, &completed_workspace_metadata)) {
    return fail(&inventory, &output, "workspace_changed");
  }
  qsort(inventory.records, inventory.count, sizeof(inventory.records[0]), record_compare);
  if (encode_inventory(&inventory, &output) != 0) return fail(&inventory, &output, "output_limit_exceeded");
  if (write_all(STDOUT_FILENO, output.bytes, output.length) != 0) return fail(&inventory, &output, "output_failed");

  free_inventory(&inventory);
  free(output.bytes);
  return 0;
}

static int collect_optional_file(inventory_t *inventory, int parent_fd, const char *name, const char *relative_path) {
  struct stat metadata;
  if (fstatat(parent_fd, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return 0;
    return -1;
  }
  return read_stable_file(inventory, parent_fd, name, relative_path);
}

static int collect_directory(inventory_t *inventory, int parent_fd, const char *name, const char *prefix) {
  int directory_fd = -1;
  struct stat directory_metadata;
  const int status = open_optional_directory(parent_fd, name, &directory_fd, &directory_metadata);
  if (status <= 0) return status;

  const int stream_fd = dup(directory_fd);
  if (stream_fd < 0) {
    (void)close(directory_fd);
    return -1;
  }
  DIR *directory = fdopendir(stream_fd);
  if (directory == NULL) {
    (void)close(stream_fd);
    (void)close(directory_fd);
    return -1;
  }

  int result = 0;
  errno = 0;
  for (struct dirent *entry = readdir(directory); entry != NULL; entry = readdir(directory)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    const size_t name_length = strnlen(entry->d_name, sizeof(entry->d_name));
    const size_t prefix_length = strlen(prefix);
    if (name_length == 0 || name_length == sizeof(entry->d_name) ||
        !validate_utf8((const uint8_t *)entry->d_name, name_length) ||
        prefix_length + name_length >= MAX_RELATIVE_PATH_BYTES) {
      result = -1;
      break;
    }
    char relative_path[MAX_RELATIVE_PATH_BYTES];
    (void)memcpy(relative_path, prefix, prefix_length);
    (void)memcpy(relative_path + prefix_length, entry->d_name, name_length + 1U);
    if (read_stable_file(inventory, directory_fd, entry->d_name, relative_path) != 0) {
      result = -1;
      break;
    }
    errno = 0;
  }
  if (errno != 0) result = -1;
  if (closedir(directory) != 0) result = -1;
  if (!directory_stable(parent_fd, name, directory_fd, &directory_metadata)) result = -1;
  if (close(directory_fd) != 0) result = -1;
  return result;
}

static int open_optional_directory(int parent_fd, const char *name, int *directory_fd, struct stat *metadata) {
  struct stat before;
  if (fstatat(parent_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return 0;
    return -1;
  }
  if (!S_ISDIR(before.st_mode)) return -1;

  const int descriptor = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return -1;
  struct stat opened;
  struct stat after;
  if (fstat(descriptor, &opened) != 0 ||
      fstatat(parent_fd, name, &after, AT_SYMLINK_NOFOLLOW) != 0 ||
      !metadata_equal(&before, &opened) ||
      !metadata_equal(&opened, &after) ||
      !S_ISDIR(opened.st_mode)) {
    (void)close(descriptor);
    return -1;
  }
  *directory_fd = descriptor;
  *metadata = opened;
  return 1;
}

static int directory_stable(int parent_fd, const char *name, int directory_fd, const struct stat *expected) {
  struct stat opened;
  struct stat current;
  return fstat(directory_fd, &opened) == 0 &&
    fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
    metadata_equal(expected, &opened) && metadata_equal(&opened, &current) && S_ISDIR(opened.st_mode);
}

static int read_stable_file(inventory_t *inventory, int parent_fd, const char *name, const char *relative_path) {
  if (inventory->count >= MAX_FILES) return -1;
  const size_t path_length = strlen(relative_path);
  if (path_length == 0 || path_length >= MAX_RELATIVE_PATH_BYTES ||
      !validate_utf8((const uint8_t *)relative_path, path_length)) return -1;
  for (size_t index = 0; index < inventory->count; index++) {
    if (inventory->records[index].path_length == path_length &&
        memcmp(inventory->records[index].path, relative_path, path_length) == 0) return -1;
  }

  struct stat before;
  if (fstatat(parent_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_size < 0 ||
      (uint64_t)before.st_size > MAX_FILE_BYTES) return -1;

  const int descriptor = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (descriptor < 0) return -1;
  struct stat opened;
  if (fstat(descriptor, &opened) != 0 || !metadata_equal(&before, &opened) ||
      !S_ISREG(opened.st_mode) || opened.st_nlink != 1) {
    (void)close(descriptor);
    return -1;
  }

  const size_t size = (size_t)opened.st_size;
  if (inventory->total_bytes > MAX_TOTAL_BYTES - size) {
    (void)close(descriptor);
    return -1;
  }
  uint8_t *content = size == 0 ? NULL : malloc(size);
  if (size != 0 && content == NULL) {
    (void)close(descriptor);
    return -1;
  }
  size_t offset = 0;
  while (offset < size) {
    const ssize_t count = read(descriptor, content + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      free(content);
      (void)close(descriptor);
      return -1;
    }
    offset += (size_t)count;
  }
  uint8_t extra;
  ssize_t trailing;
  do {
    trailing = read(descriptor, &extra, 1U);
  } while (trailing < 0 && errno == EINTR);

  struct stat completed;
  struct stat after;
  const int stable = trailing == 0 && fstat(descriptor, &completed) == 0 &&
    fstatat(parent_fd, name, &after, AT_SYMLINK_NOFOLLOW) == 0 &&
    metadata_equal(&opened, &completed) && metadata_equal(&completed, &after) &&
    completed.st_nlink == 1;
  const int close_status = close(descriptor);
  if (!stable || close_status != 0) {
    free(content);
    return -1;
  }

  for (size_t index = 0; index < inventory->count; index++) {
    if (inventory->records[index].metadata.st_dev == completed.st_dev &&
        inventory->records[index].metadata.st_ino == completed.st_ino) {
      free(content);
      return -1;
    }
  }

  record_t *record = &inventory->records[inventory->count];
  (void)memcpy(record->path, relative_path, path_length + 1U);
  record->path_length = path_length;
  record->metadata = completed;
  record->content = content;
  record->content_length = size;
  sha256_t digest;
  sha256_init(&digest);
  sha256_update(&digest, content, size);
  sha256_finish(&digest, record->digest);
  inventory->count += 1U;
  inventory->total_bytes += size;
  return 0;
}

static int metadata_equal(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
    left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
    left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
    left->st_size == right->st_size &&
    left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
    left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
    left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
    left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static int private_output_socket(int descriptor) {
  struct sockaddr_un local = {0};
  struct sockaddr_un peer = {0};
  socklen_t local_length = (socklen_t)sizeof(local);
  socklen_t peer_length = (socklen_t)sizeof(peer);
  int socket_type = 0;
  socklen_t type_length = (socklen_t)sizeof(socket_type);
  if (getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &socket_type, &type_length) != 0 ||
      type_length != sizeof(socket_type) || socket_type != SOCK_STREAM ||
      getsockname(descriptor, (struct sockaddr *)&local, &local_length) != 0 ||
      getpeername(descriptor, (struct sockaddr *)&peer, &peer_length) != 0 ||
      local.sun_family != AF_UNIX || peer.sun_family != AF_UNIX) return 0;
  const size_t local_path_bytes = local_length > offsetof(struct sockaddr_un, sun_path)
    ? (size_t)local_length - offsetof(struct sockaddr_un, sun_path) : 0U;
  const size_t peer_path_bytes = peer_length > offsetof(struct sockaddr_un, sun_path)
    ? (size_t)peer_length - offsetof(struct sockaddr_un, sun_path) : 0U;
  for (size_t index = 0; index < local_path_bytes; index++) {
    if (local.sun_path[index] != '\0') return 0;
  }
  for (size_t index = 0; index < peer_path_bytes; index++) {
    if (peer.sun_path[index] != '\0') return 0;
  }
  return 1;
}

static int validate_utf8(const uint8_t *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    const uint8_t first = bytes[index];
    if (first < 0x80U) {
      if (first == 0U) return 0;
      index += 1U;
      continue;
    }
    size_t continuation = 0;
    uint32_t codepoint = 0;
    if (first >= 0xC2U && first <= 0xDFU) {
      continuation = 1U;
      codepoint = (uint32_t)(first & 0x1FU);
    } else if (first >= 0xE0U && first <= 0xEFU) {
      continuation = 2U;
      codepoint = (uint32_t)(first & 0x0FU);
    } else if (first >= 0xF0U && first <= 0xF4U) {
      continuation = 3U;
      codepoint = (uint32_t)(first & 0x07U);
    } else {
      return 0;
    }
    if (continuation > length - index - 1U) return 0;
    for (size_t offset = 1U; offset <= continuation; offset++) {
      const uint8_t next = bytes[index + offset];
      if ((next & 0xC0U) != 0x80U) return 0;
      codepoint = (codepoint << 6U) | (uint32_t)(next & 0x3FU);
    }
    if ((continuation == 2U && codepoint < 0x800U) ||
        (continuation == 3U && codepoint < 0x10000U) ||
        codepoint > 0x10FFFFU || (codepoint >= 0xD800U && codepoint <= 0xDFFFU)) return 0;
    index += continuation + 1U;
  }
  return 1;
}

static int record_compare(const void *left_pointer, const void *right_pointer) {
  const record_t *left = left_pointer;
  const record_t *right = right_pointer;
  const size_t shared = left->path_length < right->path_length ? left->path_length : right->path_length;
  const int compared = memcmp(left->path, right->path, shared);
  if (compared != 0) return compared;
  if (left->path_length < right->path_length) return -1;
  if (left->path_length > right->path_length) return 1;
  return 0;
}

static int append_output(output_t *output, const void *bytes, size_t length) {
  if (length > MAX_OUTPUT_BYTES - output->length) return -1;
  const size_t required = output->length + length;
  if (required > output->capacity) {
    size_t capacity = output->capacity == 0 ? 4096U : output->capacity;
    while (capacity < required) {
      if (capacity > MAX_OUTPUT_BYTES / 2U) {
        capacity = MAX_OUTPUT_BYTES;
        break;
      }
      capacity *= 2U;
    }
    uint8_t *resized = realloc(output->bytes, capacity);
    if (resized == NULL) return -1;
    output->bytes = resized;
    output->capacity = capacity;
  }
  if (length != 0) (void)memcpy(output->bytes + output->length, bytes, length);
  output->length = required;
  return 0;
}

static int append_u16(output_t *output, uint16_t value) {
  const uint8_t bytes[2] = { (uint8_t)(value >> 8U), (uint8_t)value };
  return append_output(output, bytes, sizeof(bytes));
}

static int append_u32(output_t *output, uint32_t value) {
  const uint8_t bytes[4] = {
    (uint8_t)(value >> 24U), (uint8_t)(value >> 16U), (uint8_t)(value >> 8U), (uint8_t)value,
  };
  return append_output(output, bytes, sizeof(bytes));
}

static int append_u64(output_t *output, uint64_t value) {
  const uint8_t bytes[8] = {
    (uint8_t)(value >> 56U), (uint8_t)(value >> 48U), (uint8_t)(value >> 40U), (uint8_t)(value >> 32U),
    (uint8_t)(value >> 24U), (uint8_t)(value >> 16U), (uint8_t)(value >> 8U), (uint8_t)value,
  };
  return append_output(output, bytes, sizeof(bytes));
}

static int encode_inventory(const inventory_t *inventory, output_t *output) {
  static const uint8_t magic[8] = { 'A', 'S', 'T', 'R', 'X', 'I', '0', '1' };
  if (append_output(output, magic, sizeof(magic)) != 0 || append_u32(output, (uint32_t)inventory->count) != 0) return -1;
  for (size_t index = 0; index < inventory->count; index++) {
    const record_t *record = &inventory->records[index];
    if (record->path_length > UINT16_MAX || record->content_length > UINT32_MAX ||
        append_u16(output, (uint16_t)record->path_length) != 0 ||
        append_output(output, record->path, record->path_length) != 0 ||
        append_u64(output, (uint64_t)record->metadata.st_dev) != 0 ||
        append_u64(output, (uint64_t)record->metadata.st_ino) != 0 ||
        append_u64(output, (uint64_t)record->metadata.st_mode) != 0 ||
        append_u64(output, (uint64_t)record->metadata.st_nlink) != 0 ||
        append_u64(output, (uint64_t)record->metadata.st_size) != 0 ||
        append_output(output, record->digest, sizeof(record->digest)) != 0 ||
        append_u32(output, (uint32_t)record->content_length) != 0 ||
        append_output(output, record->content, record->content_length) != 0) return -1;
  }
  return 0;
}

static int write_all(int descriptor, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t count = write(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

static void free_inventory(inventory_t *inventory) {
  for (size_t index = 0; index < inventory->count; index++) free(inventory->records[index].content);
  inventory->count = 0;
  inventory->total_bytes = 0;
}

static int fail(inventory_t *inventory, output_t *output, const char *reason) {
  (void)reason;
  free_inventory(inventory);
  free(output->bytes);
  return 70;
}

static uint32_t rotate_right(uint32_t value, uint32_t shift) {
  return (value >> shift) | (value << (32U - shift));
}

static void sha256_init(sha256_t *context) {
  static const uint32_t initial[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  (void)memcpy(context->state, initial, sizeof(initial));
  context->bit_count = 0;
  context->block_length = 0;
}

static void sha256_update(sha256_t *context, const uint8_t *bytes, size_t length) {
  for (size_t index = 0; index < length; index++) {
    context->block[context->block_length++] = bytes[index];
    if (context->block_length == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->bit_count += 512U;
      context->block_length = 0;
    }
  }
}

static void sha256_finish(sha256_t *context, uint8_t digest[32]) {
  context->bit_count += (uint64_t)context->block_length * 8U;
  context->block[context->block_length++] = 0x80U;
  if (context->block_length > 56U) {
    while (context->block_length < 64U) context->block[context->block_length++] = 0U;
    sha256_transform(context, context->block);
    context->block_length = 0;
  }
  while (context->block_length < 56U) context->block[context->block_length++] = 0U;
  for (size_t index = 0; index < 8U; index++) {
    context->block[63U - index] = (uint8_t)(context->bit_count >> (index * 8U));
  }
  sha256_transform(context, context->block);
  for (size_t index = 0; index < 8U; index++) {
    digest[index * 4U] = (uint8_t)(context->state[index] >> 24U);
    digest[index * 4U + 1U] = (uint8_t)(context->state[index] >> 16U);
    digest[index * 4U + 2U] = (uint8_t)(context->state[index] >> 8U);
    digest[index * 4U + 3U] = (uint8_t)context->state[index];
  }
}

static void sha256_transform(sha256_t *context, const uint8_t block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t schedule[64];
  for (size_t index = 0; index < 16U; index++) {
    schedule[index] = ((uint32_t)block[index * 4U] << 24U) |
      ((uint32_t)block[index * 4U + 1U] << 16U) |
      ((uint32_t)block[index * 4U + 2U] << 8U) |
      (uint32_t)block[index * 4U + 3U];
  }
  for (size_t index = 16U; index < 64U; index++) {
    const uint32_t low = rotate_right(schedule[index - 15U], 7U) ^ rotate_right(schedule[index - 15U], 18U) ^ (schedule[index - 15U] >> 3U);
    const uint32_t high = rotate_right(schedule[index - 2U], 17U) ^ rotate_right(schedule[index - 2U], 19U) ^ (schedule[index - 2U] >> 10U);
    schedule[index] = schedule[index - 16U] + low + schedule[index - 7U] + high;
  }
  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (size_t index = 0; index < 64U; index++) {
    const uint32_t sigma_e = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^ rotate_right(e, 25U);
    const uint32_t choice = (e & f) ^ ((~e) & g);
    const uint32_t temporary_one = h + sigma_e + choice + constants[index] + schedule[index];
    const uint32_t sigma_a = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^ rotate_right(a, 22U);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temporary_two = sigma_a + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary_one;
    d = c;
    c = b;
    b = a;
    a = temporary_one + temporary_two;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}
