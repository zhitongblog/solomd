use app_lib::commands::copy_file;
use std::fs;

#[test]
fn copy_creates_parent_dirs() {
    let src = "/tmp/solomd-copy-src.png".to_string();
    let dst = "/tmp/solomd-copy-test/_assets/nested/image.png".to_string();
    let _ = fs::remove_dir_all("/tmp/solomd-copy-test");
    let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG header
    fs::write(&src, &bytes).unwrap();

    copy_file(src, dst.clone()).unwrap();

    let copied = fs::read(&dst).unwrap();
    assert_eq!(copied, vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

#[test]
fn copy_overwrites_existing() {
    let src = "/tmp/solomd-copy-src2.png".to_string();
    let dst = "/tmp/solomd-copy-dst2.png".to_string();
    fs::write(&src, b"new").unwrap();
    fs::write(&dst, b"old").unwrap();

    copy_file(src, dst.clone()).unwrap();

    assert_eq!(fs::read(&dst).unwrap(), b"new");
}

#[test]
fn copy_missing_source_errors() {
    let src = "/tmp/solomd-does-not-exist.png".to_string();
    let dst = "/tmp/solomd-dst-fail.png".to_string();
    let result = copy_file(src, dst);
    assert!(result.is_err());
}

#[test]
fn write_binary_creates_parent_dirs() {
    use app_lib::commands::write_binary_file;
    let _ = fs::remove_dir_all("/tmp/solomd-bin-test");
    let path = "/tmp/solomd-bin-test/sub/dir/file.bin".to_string();
    write_binary_file(path.clone(), vec![1, 2, 3, 4]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), vec![1, 2, 3, 4]);
}
