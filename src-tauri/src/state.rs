//! 열려 있는 프로젝트(워크스페이스)들의 런타임 상태.
//!
//! 글로벌 DB 를 두지 않고 프로젝트마다 커넥션을 하나씩 들고 있는다.
//! `rusqlite::Connection` 은 `Sync` 가 아니므로 전체를 `Mutex` 로 감싼다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::db::models::Project;
use crate::error::{AppError, AppResult};
use crate::paths;

pub struct Workspace {
    pub project: Project,
    pub root: PathBuf,
    pub conn: Connection,
}

#[derive(Default)]
struct Inner {
    workspaces: HashMap<String, Workspace>,
    active: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    inner: Mutex<Inner>,
}

impl AppState {
    pub fn key_of(root: &Path) -> String {
        paths::compare_key(root)
    }

    /// 워크스페이스를 등록하고 활성 프로젝트로 지정한다.
    pub fn insert(&self, root: PathBuf, project: Project, conn: Connection) -> AppResult<String> {
        let key = Self::key_of(&root);
        let mut inner = self.lock()?;
        inner.workspaces.insert(
            key.clone(),
            Workspace {
                project,
                root,
                conn,
            },
        );
        inner.active = Some(key.clone());
        Ok(key)
    }

    pub fn close(&self, root_path: &str) -> AppResult<bool> {
        let key = Self::key_of(&paths::absolutize(root_path)?);
        let mut inner = self.lock()?;
        let removed = inner.workspaces.remove(&key).is_some();
        if inner.active.as_deref() == Some(key.as_str()) {
            inner.active = inner.workspaces.keys().next().cloned();
        }
        Ok(removed)
    }

    pub fn set_active(&self, root_path: &str) -> AppResult<()> {
        let key = Self::key_of(&paths::absolutize(root_path)?);
        let mut inner = self.lock()?;
        if !inner.workspaces.contains_key(&key) {
            return Err(AppError::NoProject(format!(" ({root_path})")));
        }
        inner.active = Some(key);
        Ok(())
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let inner = self.lock()?;
        Ok(inner
            .workspaces
            .values()
            .map(|w| w.project.clone())
            .collect())
    }

    pub fn active_project(&self) -> AppResult<Option<Project>> {
        let inner = self.lock()?;
        Ok(inner
            .active
            .as_ref()
            .and_then(|key| inner.workspaces.get(key))
            .map(|w| w.project.clone()))
    }

    /// 프로젝트 루트를 알아낸다. `project_path` 가 없으면 활성 프로젝트를 쓴다.
    pub fn root_of(&self, project_path: Option<&str>) -> AppResult<PathBuf> {
        self.with(project_path, |ws| Ok(ws.root.clone()))
    }

    /// 대상 워크스페이스에 대해 클로저를 실행한다. DB 접근의 유일한 진입점.
    pub fn with<T>(
        &self,
        project_path: Option<&str>,
        func: impl FnOnce(&mut Workspace) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut inner = self.lock()?;

        let key = match project_path {
            Some(path) => Self::key_of(&paths::absolutize(path)?),
            None => inner
                .active
                .clone()
                .ok_or_else(|| AppError::NoProject(String::new()))?,
        };

        let workspace = inner
            .workspaces
            .get_mut(&key)
            .ok_or_else(|| AppError::NoProject(format!(" ({key})")))?;

        func(workspace)
    }

    /// 편의 래퍼: 커넥션만 필요할 때.
    pub fn with_conn<T>(
        &self,
        project_path: Option<&str>,
        func: impl FnOnce(&mut Connection, &Project) -> AppResult<T>,
    ) -> AppResult<T> {
        self.with(project_path, |ws| {
            let project = ws.project.clone();
            func(&mut ws.conn, &project)
        })
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::invalid("워크스페이스 상태 잠금 실패 (poisoned)"))
    }
}
