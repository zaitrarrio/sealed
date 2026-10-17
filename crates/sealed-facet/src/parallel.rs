//! Row-parallel helpers over `std::thread::scope`. Threads are used only with the `threads` feature on targets
//! that have them (never on wasm32); otherwise every helper runs its work serially on the calling thread, with
//! the same partition, so results do not depend on the thread count.

/// Upper bound on worker threads (the work here is memory-bound beyond a handful of cores).
#[cfg(all(feature = "threads", not(target_arch = "wasm32")))]
const MAX_WORKERS: usize = 8;

#[cfg(all(feature = "threads", not(target_arch = "wasm32")))]
pub(crate) fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .clamp(1, MAX_WORKERS)
}

#[cfg(not(all(feature = "threads", not(target_arch = "wasm32"))))]
pub(crate) fn worker_count() -> usize {
    1
}

/// Splits `data` (rows of `row_len` elements) into at most `parts` contiguous row ranges whose lengths are
/// multiples of `align` rows (except the last), and runs `f(first_row, rows)` on each: on scoped threads when
/// threads are available and the split has more than one part, serially otherwise. Callers compute every part
/// independently of the others, so the result does not depend on the partition or the thread count.
pub(crate) fn par_rows<T, F>(data: &mut [T], row_len: usize, align: usize, parts: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync,
{
    let row_len = row_len.max(1);
    let rows = data.len() / row_len;
    let align = align.max(1);
    let parts = parts.clamp(1, rows.max(1));
    let per = rows.div_ceil(parts).div_ceil(align) * align;
    let chunk = per.max(align) * row_len;
    if chunk == 0 || data.len() <= chunk {
        f(0, data);
        return;
    }
    run_chunks(data, chunk, row_len, &f);
}

#[cfg(all(feature = "threads", not(target_arch = "wasm32")))]
fn run_chunks<T, F>(data: &mut [T], chunk: usize, row_len: usize, f: &F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync,
{
    if worker_count() <= 1 {
        for (i, c) in data.chunks_mut(chunk).enumerate() {
            f(i * (chunk / row_len), c);
        }
        return;
    }
    std::thread::scope(|s| {
        let mut iter = data.chunks_mut(chunk).enumerate();
        // The first part runs on the calling thread; the others on scoped threads.
        let first = iter.next();
        for (i, c) in iter {
            s.spawn(move || f(i * (chunk / row_len), c));
        }
        if let Some((i, c)) = first {
            f(i * (chunk / row_len), c);
        }
    });
}

#[cfg(not(all(feature = "threads", not(target_arch = "wasm32"))))]
fn run_chunks<T, F>(data: &mut [T], chunk: usize, row_len: usize, f: &F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync,
{
    for (i, c) in data.chunks_mut(chunk).enumerate() {
        f(i * (chunk / row_len), c);
    }
}

/// Number of parts to split `rows` rows of work into: one per worker, but never so many that a part would hold
/// fewer than `min_rows` rows.
pub(crate) fn parts_for(rows: usize, min_rows: usize) -> usize {
    let w = worker_count();
    if w <= 1 {
        return 1;
    }
    (rows / min_rows.max(1)).clamp(1, w)
}

/// [`par_rows`] over two buffers partitioned alike: `data` in rows of `row_len`, `data2` in rows of `row_len2`,
/// the same row ranges for both. `f(first_row, rows, rows2)`.
pub(crate) fn par_rows_pair<T, U, F>(
    data: &mut [T],
    row_len: usize,
    data2: &mut [U],
    row_len2: usize,
    align: usize,
    parts: usize,
    f: F,
) where
    T: Send,
    U: Send,
    F: Fn(usize, &mut [T], &mut [U]) + Sync,
{
    let row_len = row_len.max(1);
    let row_len2 = row_len2.max(1);
    let rows = (data.len() / row_len).min(data2.len() / row_len2);
    let align = align.max(1);
    let parts = parts.clamp(1, rows.max(1));
    let per = (rows.div_ceil(parts).div_ceil(align) * align).max(align);
    if rows <= per {
        f(0, data, data2);
        return;
    }
    let pairs: Vec<(usize, &mut [T], &mut [U])> = data[..rows * row_len]
        .chunks_mut(per * row_len)
        .zip(data2[..rows * row_len2].chunks_mut(per * row_len2))
        .enumerate()
        .map(|(i, (a, b))| (i * per, a, b))
        .collect();
    run_pairs(pairs, &f);
}

#[cfg(all(feature = "threads", not(target_arch = "wasm32")))]
fn run_pairs<T, U, F>(pairs: Vec<(usize, &mut [T], &mut [U])>, f: &F)
where
    T: Send,
    U: Send,
    F: Fn(usize, &mut [T], &mut [U]) + Sync,
{
    if worker_count() <= 1 {
        for (r, a, b) in pairs {
            f(r, a, b);
        }
        return;
    }
    std::thread::scope(|s| {
        let mut iter = pairs.into_iter();
        let first = iter.next();
        for (r, a, b) in iter {
            s.spawn(move || f(r, a, b));
        }
        if let Some((r, a, b)) = first {
            f(r, a, b);
        }
    });
}

#[cfg(not(all(feature = "threads", not(target_arch = "wasm32"))))]
fn run_pairs<T, U, F>(pairs: Vec<(usize, &mut [T], &mut [U])>, f: &F)
where
    T: Send,
    U: Send,
    F: Fn(usize, &mut [T], &mut [U]) + Sync,
{
    for (r, a, b) in pairs {
        f(r, a, b);
    }
}
