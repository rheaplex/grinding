// NVRTC compiles this with no system headers, so define the fixed-width type
// we need instead of pulling in <cstdint>.
typedef unsigned int uint32_t;

// ---------------------------------------------------------------------------
// SHA-256 core (single 512-bit block). The preimage is `setup ‖ nonce`, where
// the host makes setup either the plaintext source (<= 32 bytes) or
// SHA256(source) (32 bytes) — so the preimage is at most 40 bytes and always
// fits one block.
// ---------------------------------------------------------------------------

__constant__ uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

__constant__ uint32_t H0[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
};

__device__ __forceinline__ uint32_t rotr(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32 - n));
}
__device__ __forceinline__ uint32_t ch(uint32_t x, uint32_t y, uint32_t z)  { return (x & y) ^ (~x & z); }
__device__ __forceinline__ uint32_t maj(uint32_t x, uint32_t y, uint32_t z) { return (x & y) ^ (x & z) ^ (y & z); }
__device__ __forceinline__ uint32_t ep0(uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
__device__ __forceinline__ uint32_t ep1(uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
__device__ __forceinline__ uint32_t sig0(uint32_t x){ return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
__device__ __forceinline__ uint32_t sig1(uint32_t x){ return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }

__device__ void sha256_transform(const uint32_t msg[16], uint32_t h[8]) {
    uint32_t w[64];
    #pragma unroll
    for (int i = 0; i < 16; i++) w[i] = msg[i];
    #pragma unroll
    for (int i = 16; i < 64; i++)
        w[i] = sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16];

    uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
    uint32_t e = h[4], f = h[5], g = h[6], h_ = h[7];

    #pragma unroll
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h_ + ep1(e) + ch(e, f, g) + K[i] + w[i];
        uint32_t t2 = ep0(a) + maj(a, b, c);
        h_ = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += h_;
}

// Extract the 32-bit big-endian window of `a` (8 words = 256 bits) starting at
// bit position `p`. Bit 0 is the MSB of a[0]. Reads past the end yield zeros.
__device__ __forceinline__ uint32_t win32(const uint32_t a[8], uint32_t p) {
    uint32_t w = p >> 5, b = p & 31u;
    uint32_t hi = (w < 8) ? a[w] : 0u;
    uint32_t lo = (w + 1 < 8) ? a[w + 1] : 0u;
    return (b == 0) ? hi : (hi << b) | (lo >> (32u - b));
}

// ---------------------------------------------------------------------------
// Vanity search kernel.
//
// One (setup, target) search at a time, host-driven. Every thread grinds `iters`
// nonces from a grid-strided slice of the nonce space, hashes preimage =
// template with the 64-bit little-endian nonce injected at `nonce_byte_offset`,
// then finds the LONGEST run of leading target bits (under the care-mask) that
// matches the digest, sliding the target over `num_positions` starting bit
// offsets (1 = prefix only; 256 = anywhere). The best (length, position, nonce)
// of the launch is reduced into `best` via atomicMax.
//
// Encoding-agnostic: the kernel sees only a target bitstring + care-mask.
//
// `best` packs (length << 55) | ((255 - position) << 47) | (nonce - base_nonce).
// Longest wins; ties prefer the smallest position (so a full PREFIX match is the
// global maximum). The host recovers position and absolute nonce.
// ---------------------------------------------------------------------------

extern "C" __global__ void sha256_search(
    const uint32_t* __restrict__ template_words, // 16 words, nonce region zeroed
    uint32_t nonce_byte_offset,                  // byte offset of the 8 LE nonce bytes
    const uint32_t* __restrict__ target_words,   // 8 words, masked to zero past num_bits
    const uint32_t* __restrict__ care_words,     // 8 words, 1 = bit must match, 0 = don't-care
    uint32_t num_bits,                           // target length, in bits
    uint32_t num_positions,                      // start offsets to try: 1 (prefix) or 256 (anywhere)
    unsigned long long base_nonce,               // first nonce of this launch
    uint32_t iters,                              // nonces per thread
    unsigned long long total_threads,            // grid stride
    unsigned long long* best)                    // packed (len << 55)|((255-pos) << 47)|offset
{
    unsigned long long tid =
        (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;

    uint32_t tmpl[16];
    #pragma unroll
    for (int i = 0; i < 16; i++) tmpl[i] = template_words[i];

    uint32_t tgt[8];
    uint32_t care[8];
    #pragma unroll
    for (int i = 0; i < 8; i++) { tgt[i] = target_words[i]; care[i] = care_words[i]; }

    uint32_t best_len = 0, best_pos = 0;
    unsigned long long best_off = 0;

    for (uint32_t it = 0; it < iters; it++) {
        unsigned long long offset = tid + (unsigned long long)it * total_threads;
        unsigned long long nonce = base_nonce + offset;

        // Build the message block: template + nonce injected as 8 LE bytes.
        uint32_t msg[16];
        #pragma unroll
        for (int i = 0; i < 16; i++) msg[i] = tmpl[i];

        #pragma unroll
        for (int k = 0; k < 8; k++) {
            uint32_t byte = (uint32_t)((nonce >> (8 * k)) & 0xffu);
            uint32_t p = nonce_byte_offset + k;          // preimage byte index
            uint32_t w = p >> 2;                         // which 32-bit word
            uint32_t r = p & 3u;                         // byte within the word
            msg[w] |= byte << ((3u - r) * 8u);           // words are big-endian
        }

        uint32_t h[8];
        #pragma unroll
        for (int i = 0; i < 8; i++) h[i] = H0[i];
        sha256_transform(msg, h);

        // Slide the target over the requested start positions; keep the longest
        // matching run (ties prefer the smaller position).
        for (uint32_t pos = 0; pos < num_positions; pos++) {
            uint32_t len = 0;
            while (len < num_bits && (pos + len) < 256u) {
                uint32_t remaining = num_bits - len;
                uint32_t avail = 256u - (pos + len);
                uint32_t chunk = remaining < 32u ? remaining : 32u;
                if (avail < chunk) chunk = avail;
                uint32_t mask = (chunk == 32u) ? 0xffffffffu : (0xffffffffu << (32u - chunk));
                uint32_t x = ((win32(h, pos + len) ^ win32(tgt, len)) & win32(care, len)) & mask;
                if (x == 0u) { len += chunk; if (chunk < 32u) break; }
                else { len += __clz(x); break; }
            }
            // Longer wins; ties prefer the smaller (more prefix-y) position.
            if (len > best_len || (len == best_len && pos < best_pos)) {
                best_len = len; best_pos = pos; best_off = offset;
            }
        }
    }

    if (best_len > 0) {
        unsigned long long packed =
            ((unsigned long long)best_len << 55) |
            ((unsigned long long)(255u - best_pos) << 47) |
            (best_off & 0x7fffffffffffULL);
        atomicMax(best, packed);
    }
}
