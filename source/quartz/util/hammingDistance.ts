export const hammingDistance = (a: Uint8Array, b: Uint8Array): number => a.reduce((sum, _, index) => {
    // Brian Kernighan’s Algorithm
    let n = a[index] ^ b[index];
    let distance = 0;
    while (n) {
        n &= (n - 1)
        distance += 1
    }
    return sum + distance;
}, 0);

